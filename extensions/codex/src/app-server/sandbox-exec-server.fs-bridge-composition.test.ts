import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createRemoteShellSandboxFsBridge,
  type SandboxBackendCommandParams,
  type SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";
import { afterEach, expect, it } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  codexFsSandboxContext,
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  rpc,
  specialPath,
} from "./sandbox-exec-server.test-helpers.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

const SANDBOX_MOUNT = "/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function rewritePortableStatScript(script: string): string {
  if (process.platform !== "darwin") {
    return script;
  }
  return script
    .replace(
      'LC_ALL=C stat -c "%F|%s|%y" -- "$1"',
      String.raw`kind=$(LC_ALL=C stat -f "%HT" -- "$1" | tr "[:upper:]" "[:lower:]")
size=$(LC_ALL=C stat -f "%z" -- "$1")
mtime=$(LC_ALL=C stat -f "%m" -- "$1")
printf "%s|%s|%s\n" "$kind" "$size" "$mtime"`,
    )
    .replace(
      'stats=$(LC_ALL=C stat -c "%F|%h" -- "$1")',
      String.raw`kind=$(LC_ALL=C stat -f "%HT" -- "$1" | tr "[:upper:]" "[:lower:]")
links=$(LC_ALL=C stat -f "%l" -- "$1")
stats="$kind|$links"`,
    );
}

function rewriteMountArgs(args: string[] | undefined, mountDir: string): string[] {
  return (args ?? []).map((arg) =>
    arg === SANDBOX_MOUNT || arg.startsWith(`${SANDBOX_MOUNT}/`)
      ? `${mountDir}${arg.slice(SANDBOX_MOUNT.length)}`
      : arg,
  );
}

async function runLocalShellScript(
  command: SandboxBackendCommandParams,
  mountDir: string,
): Promise<SandboxBackendCommandResult> {
  const child = spawn(
    "sh",
    [
      "-c",
      rewritePortableStatScript(command.script),
      "composition-shell",
      ...rewriteMountArgs(command.args, mountDir),
    ],
    { stdio: "pipe" },
  );
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const closed = once(child, "close");
  child.stdin?.end(command.stdin);
  const [code] = await closed;
  return {
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
    code: typeof code === "number" ? code : 0,
  };
}

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

it.runIf(process.platform !== "win32")(
  "rejects protected canonical destinations before filesystem effects and lands allowed writes exactly",
  async () => {
    const stateDir = tempDirs.make("openclaw-codex-fs-composition-");
    const mountDir = path.join(await fs.realpath(stateDir), "workspace");
    const local = (...parts: string[]) => path.join(mountDir, ...parts);
    const expectFile = (filePath: string, content: string) =>
      expect(fs.readFile(local(filePath), "utf8")).resolves.toBe(content);
    const mkdir = (filePath: string) => fs.mkdir(local(filePath), { recursive: true });
    const link = (target: string, alias: string) => fs.symlink(local(target), local(alias));
    const writeLocal = (filePath: string, data: string) => fs.writeFile(local(filePath), data);
    await mkdir(".git");
    await mkdir("real");
    await link(".git", "alias");
    await link("real", "alias-real");

    let mutationCalls = 0;
    const runtime = {
      remoteWorkspaceDir: SANDBOX_MOUNT,
      remoteAgentWorkspaceDir: SANDBOX_MOUNT,
      runRemoteShellScript: async (command: SandboxBackendCommandParams) => {
        if (command.script.includes("operation = sys.argv[1]")) {
          mutationCalls += 1;
        }
        return await runLocalShellScript(command, mountDir);
      },
    };
    const runShell = (command: SandboxBackendCommandParams) =>
      runLocalShellScript(command, mountDir);
    const fsBridge = createRemoteShellSandboxFsBridge({
      sandbox: {
        workspaceDir: mountDir,
        agentWorkspaceDir: mountDir,
        workspaceAccess: "rw",
      } as never,
      runtime: runtime as never,
    });
    const client = createClient();
    await ensureCodexSandboxExecServerEnvironment({
      client: client as never,
      sandbox: { ...createSandboxContext({ runShellCommand: runShell }), fsBridge },
    });
    const socket = await openSocket(execServerUrlFromClient(client));
    await rpc(socket, "initialize", { clientName: "test" });
    socket.send(JSON.stringify({ method: "initialized" }));
    const workspacePolicy = codexFsSandboxContext({
      entries: [
        { path: specialPath("root"), access: "read" },
        { path: specialPath("project_roots"), access: "write" },
        { path: specialPath("project_roots", ".git"), access: "read" },
      ],
    });
    const write = (filePath: string, data: string) =>
      rpc(socket, "fs/writeFile", {
        path: `file:///workspace/${filePath}`,
        dataBase64: Buffer.from(data).toString("base64"),
        sandbox: workspacePolicy,
      });
    const copy = (destination: string, source = "nested/src-dir") =>
      rpc(socket, "fs/copy", {
        sourcePath: `file:///workspace/${source}`,
        destinationPath: destination ? `file:///workspace/${destination}` : "file:///workspace",
        recursive: true,
        sandbox: workspacePolicy,
      });

    await expect(write("alias/config", "blocked")).rejects.toThrow(
      "Codex fs sandbox denied write access",
    );
    await expect(fs.stat(local(".git/config"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(mutationCalls).toBe(0);

    await write("real-note.txt", "allowed");
    await expectFile("real-note.txt", "allowed");
    expect(mutationCalls).toBeGreaterThan(0);

    await write("alias-real/config", "aliased");
    await expectFile("real/config", "aliased");

    // Existing directory roots must resolve as directories, not file-backed parents.
    await mkdir("nested/src-dir");
    await writeLocal("nested/src-dir/child.txt", "dir-copy");
    await copy("");
    await expectFile("child.txt", "dir-copy");

    // An alias must not hide a copy into the source subtree.
    await mkdir("nested/src-dir/subdir");
    await link("nested/src-dir/subdir", "source-subdir-alias");
    const mutationsBeforeRejectedCopy = mutationCalls;
    await expect(copy("source-subdir-alias")).rejects.toThrow(
      "Cannot recursively copy a directory into itself",
    );
    expect(mutationCalls).toBe(mutationsBeforeRejectedCopy);
    await expect(fs.stat(local("nested/src-dir/subdir/child.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // A directory alias must pin the target directory itself.
    await mkdir("dir-target");
    await link("dir-target", "alias-dir");
    await copy("alias-dir");
    await expectFile("dir-target/child.txt", "dir-copy");
    const fileName = "tab\tand\nnewline.txt";
    const directoryName = "sub\tline\nfolder";
    const nestedName = "nested\tline\nfile.txt";
    await mkdir(`names-source/${directoryName}`);
    await writeLocal(`names-source/${fileName}`, "top-level bytes");
    await writeLocal(`names-source/${directoryName}/${nestedName}`, "nested bytes");

    const listing = (await rpc(socket, "fs/readDirectory", {
      path: "file:///workspace/names-source",
      sandbox: workspacePolicy,
    })) as { entries: Array<{ fileName: string; isDirectory: boolean; isFile: boolean }> };
    expect.soft(listing.entries.toSorted((a, b) => a.fileName.localeCompare(b.fileName))).toEqual([
      { fileName: directoryName, isDirectory: true, isFile: false },
      { fileName, isDirectory: false, isFile: true },
    ]);

    await expect(copy("names-copy", "names-source")).resolves.toEqual({});
    expect((await fs.readdir(local("names-copy"))).toSorted()).toEqual(
      [directoryName, fileName].toSorted(),
    );
    await expectFile(`names-copy/${fileName}`, "top-level bytes");
    expect(await fs.readdir(local("names-copy", directoryName))).toEqual([nestedName]);
    await expectFile(`names-copy/${directoryName}/${nestedName}`, "nested bytes");
    socket.close();
  },
);

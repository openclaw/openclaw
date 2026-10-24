import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test/helpers/temp-dir.js";
import { ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT } from "./remote-shell-command.js";
import {
  buildExecRemoteCommand,
  buildRemoteWorkdirValidationCommand,
  buildValidatedExecRemoteCommand,
  createSshSandboxSessionFromConfigText,
  createSshSandboxSessionFromSettings,
  disposeSshSandboxSession,
  type SshSandboxSession,
  type SshSandboxSettings,
  uploadDirectoryToSshTarget,
} from "./ssh.js";

const sessions: SshSandboxSession[] = [];
const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);
const runScript = (script: string, ...args: string[]) =>
  execFileAsync("/bin/sh", ["-c", script, ...args]);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sessions.splice(0).map(disposeSshSandboxSession));
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createSession(settings: Partial<SshSandboxSettings>) {
  const session = await createSshSandboxSessionFromSettings({
    command: "ssh",
    target: "peter@example.com:2222",
    strictHostKeyChecking: true,
    updateHostKeys: false,
    ...settings,
  });
  sessions.push(session);
  return session;
}

const validateWorkdir = (workdir: string, root: string) =>
  runScript(buildRemoteWorkdirValidationCommand({ workdir, root }));
const validatedCommand = (command: string) => buildValidatedExecRemoteCommand({ command, env: {} });
const ensureDirectory = (target: string, root: string, script = "exit 0") =>
  runScript(`${ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT}\n${script}`, "remote-dir", target, root);

async function workspaceTree() {
  const root = makeTempDir(tempDirs, "openclaw-ssh-workdir-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  return { root, workspace };
}

describe("sandbox ssh helpers", () => {
  it("materializes inline SSH auth data into a temp config", async () => {
    const session = await createSession({
      identityData: "a\r\nb\\nc\\r\\nd",
      certificateData: "SSH CERT",
      knownHostsData: "host key",
    });

    const config = await fs.readFile(session.configPath, "utf8");
    expect(config).toContain("Host openclaw-sandbox");
    expect(config).toContain("HostName example.com");
    expect(config).toContain("User peter");
    expect(config).toContain("Port 2222");
    expect(config).toContain("StrictHostKeyChecking yes");
    expect(config).toContain("UpdateHostKeys no");

    const configDir = path.dirname(session.configPath);
    expect(await fs.readFile(`${configDir}/identity`, "utf8")).toBe("a\nb\nc\nd\n");
    expect(await fs.readFile(`${configDir}/certificate.pub`, "utf8")).toBe("SSH CERT\n");
    expect(await fs.readFile(`${configDir}/known_hosts`, "utf8")).toBe("host key\n");
  });

  it("removes the temp config directory when chmod fails", async () => {
    const injectedError = new Error("injected chmod failure");
    const chmod = vi.spyOn(fs, "chmod").mockRejectedValueOnce(injectedError);
    await expect(createSshSandboxSessionFromConfigText({ configText: "Host test\n" })).rejects.toBe(
      injectedError,
    );
    expect(chmod).toHaveBeenCalledOnce();
    const configDir = path.dirname(String(chmod.mock.calls[0]?.[0]));
    tempDirs.push(configDir);
    await expect(fs.access(configDir)).rejects.toThrow();
  });

  it("rejects paths that inject ssh config directives", async () => {
    await expect(createSession({ knownHostsFile: "/key\nUser injected" })).rejects.toThrow(
      "SSH sandbox knownHostsFile must not contain line breaks or double quotes.",
    );
  });

  it("quotes path directives containing whitespace", async () => {
    const session = await createSession({
      identityFile: "/tmp/Application Support/lease/id_ed25519",
      knownHostsFile: "/tmp/Application Support/lease/known_hosts",
    });

    const config = await fs.readFile(session.configPath, "utf8");
    expect(config).toContain('  IdentityFile "/tmp/Application Support/lease/id_ed25519"');
    expect(config).toContain('  UserKnownHostsFile "/tmp/Application Support/lease/known_hosts"');
  });

  it("rejects configured environment values in the validated remote command builder", () => {
    expect(() =>
      buildValidatedExecRemoteCommand({
        command: "pwd && printenv SYNTHETIC_VALUE",
        workdir: "/sandbox/project",
        env: { SYNTHETIC_VALUE: "synthetic-ssh-command-value" },
      }),
    ).toThrow(/environment.*secure|secure.*environment/i);
  });

  it("keeps the public exec command builder quote-only for compatibility", () => {
    const command = buildExecRemoteCommand({
      command: "workflow run <workflow-id> --ref main",
      workdir: "/sandbox/project",
      env: {},
    });

    expect(command).toContain(`'/bin/sh'`);
    expect(command).toContain(
      `'cd '"'"'/sandbox/project'"'"' && workflow run <workflow-id> --ref main'`,
    );
  });

  it.each([
    ["echo $(workflow run <workflow-id> --ref main)", /unresolved placeholder token <workflow-id>/],
    ["WORKFLOW_ID=<workflow-id> workflow run", /unresolved placeholder token <workflow-id>/],
    ["printf '%s", /unclosed single quote/],
    ["echo foo\\", /trailing backslash escape/],
    ['echo "$((1 << 2)', /unterminated arithmetic expansion/],
    ["cat <<EOF", /unterminated here-doc EOF/],
    ["cat <<EOF\nstill open", /unterminated here-doc EOF/],
  ])("rejects malformed generated exec commands: %s", (rawCommand, message) => {
    expect(() => validatedCommand(rawCommand)).toThrow(message);
  });

  it("allows shell features and quoted placeholder-looking text", () => {
    const command = [
      "cat < input.txt > output.txt",
      "cat <in>out",
      "cat <input> output",
      "cat = <input-file> output.txt",
      'cat <input-file> "output file"',
      "cat <<'EOF' > literal.txt",
      "<workflow-id>",
      '"unterminated quote text is data here',
      "`unterminated backtick text is data here",
      "EOF",
      ": <<EOF $(printf '%s' hi\n)\nbody\nEOF",
      "echo $(cat <<EOF\ninside\nEOF\n)",
      "cat <<EOF\r\nwindows line endings\r\nEOF\r\n",
      'cat <<E"OF"\nmixed delimiter quotes\nEOF',
      "cat <<\\EOF\nescaped delimiter\nEOF",
      "echo $(printf '%s' ok)",
      "echo \"$(printf '%s' ok)\"",
      "echo `date`",
      'echo "`date`"',
      "diff <(sort left.txt) <(sort right.txt)",
      "echo $((1 << 2))",
      'echo "$((1 << 2))"',
      'printf "%s\\n" "<name>"',
      "# workflow run <workflow-id>",
    ].join("\n");
    expect(() => validatedCommand(command)).not.toThrow();
  });

  describe.runIf(process.platform !== "win32")("filesystem", () => {
    it("preserves args after directory validation", async () => {
      const realParent = makeTempDir(tempDirs, "openclaw-ssh-real-");
      const linkParent = `${realParent}-link`;
      tempDirs.push(linkParent);
      await fs.symlink(realParent, linkParent);
      const root = path.join(linkParent, "runtime");
      const relativeTarget = path.join("runtime", "workspace", ".openclaw", "sandbox-skills");
      const target = path.join(linkParent, relativeTarget);

      const { stdout } = await ensureDirectory(
        target,
        root,
        [
          'printf "%s\\n%s\\n" "$1" "$2"',
          'touch "$1/proof"',
          'find "$1" -mindepth 1 -maxdepth 1 -name proof -print',
        ].join("\n"),
      );

      expect(stdout.trim().split("\n")).toEqual([target, root, path.join(target, "proof")]);
      await expect(fs.stat(path.join(realParent, relativeTarget, "proof"))).resolves.toMatchObject({
        dev: expect.any(Number),
      });
    });

    it("validates workdirs without creating missing directories", async () => {
      const { workspace } = await workspaceTree();
      const project = path.join(workspace, "project one");
      await fs.mkdir(project, { recursive: true });
      const canonicalProject = await fs.realpath(project);

      const { stdout } = await validateWorkdir(canonicalProject, "/");

      expect(stdout.trim()).toBe(canonicalProject);
      await expect(validateWorkdir(path.join(workspace, "missing"), workspace)).rejects.toThrow(
        /remote directory not found/,
      );
      await expect(fs.stat(path.join(workspace, "missing"))).rejects.toThrow();
    });

    it.each([
      ["exec workdir", validateWorkdir, ""],
      ["created directory", ensureDirectory, "sandbox-skills"],
    ] as const)("rejects symlinked %s inside the trusted root", async (_, run, suffix) => {
      const { root, workspace } = await workspaceTree();
      const link = path.join(workspace, "escape");
      await fs.symlink(root, link);
      if (suffix) {
        expect(ENSURE_REMOTE_REAL_DIRECTORY_SCRIPT.split("\n")[0]).toBe("set -e");
      }
      await expect(run(path.join(link, suffix), workspace)).rejects.toThrow(
        /unsafe remote directory symlink/,
      );
    });

    it("rejects upload symlinks escaping the workspace", async () => {
      const localDir = makeTempDir(tempDirs, "openclaw-ssh-upload-");
      await fs.symlink("/etc", path.join(localDir, "escape"));

      await expect(
        uploadDirectoryToSshTarget({
          session: await createSession({}),
          localDir,
          remoteDir: "/remote/workspace",
        }),
      ).rejects.toThrow(/refuses symlink escaping the workspace: escape/i);
    });
  });
});

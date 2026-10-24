import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveIMessageChatDbLookupPath } from "../cli-path.js";
import { getCachedIMessageRemoteHost, resolveIMessageRemoteHost } from "../remote-host.js";

const execFileAsync = promisify(execFile);
const cliPathModuleUrl = new URL("../cli-path.ts", import.meta.url).href;
async function runUserPathProbe(cliPath: string, cwd: string) {
  const source = [
    'import fs from "node:fs/promises";',
    'import os from "node:os";',
    "const { expandIMessageUserPath } = await import(process.argv[1]);",
    "const expanded = expandIMessageUserPath(process.argv[2]);",
    "const content = await fs.readFile(expanded, 'utf8').catch(() => null);",
    "process.stdout.write(JSON.stringify({ accountHome: os.userInfo().homedir, expanded, content }));",
  ].join("\n");
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source, cliPathModuleUrl, cliPath],
    { cwd, env: { ...process.env, HOME: "" } },
  );
  return JSON.parse(stdout) as { accountHome: string; expanded: string; content: string | null };
}

describe("detectRemoteHostFromCliPath", () => {
  const tempDirs: string[] = [];
  async function tempDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-"));
    tempDirs.push(dir);
    return dir;
  }
  async function wrapper(content: string, dir?: string, basename = "imsg-remote") {
    const wrapperDir = dir ?? (await tempDir());
    await fs.mkdir(wrapperDir, { recursive: true });
    const wrapperPath = path.join(wrapperDir, basename);
    await fs.writeFile(wrapperPath, content);
    return wrapperPath;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("uses the system home when HOME is blank", async () => {
    const home = await tempDir();
    vi.stubEnv("HOME", "");
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
    await wrapper(
      '#!/bin/sh\nexec ssh user@example.test imsg "$@"\n',
      path.join(home, ".openclaw"),
    );

    await expect(resolveIMessageRemoteHost({ cliPath: "~/.openclaw/imsg-remote" })).resolves.toBe(
      "user@example.test",
    );
  });

  it("never selects a working-directory tilde shadow when HOME is blank", async () => {
    const cwd = await tempDir();
    const basename = `imsg-${randomUUID()}`;
    await wrapper(
      "#!/bin/sh\nexec ssh rogue@example.test imsg\n",
      path.join(cwd, "~", ".openclaw"),
      basename,
    );

    const result = await runUserPathProbe(`~/.openclaw/${basename}`, cwd);

    expect(result.expanded).toBe(path.join(result.accountHome, ".openclaw", basename));
    expect(result.content).toBeNull();
  });

  it.each([
    ["missing argument forwarding", "#!/bin/sh\nexec ssh bot@messages-mac imsg\n"],
    ["continued simple ssh", '#!/bin/sh\nexec \\\nssh bot@messages-mac imsg "$@"\n'],
    [
      "quoted ssh in a complex script",
      '#!/bin/sh\nif true; then\n  "/usr/bin/ssh" bot@messages-mac imsg "$@"\nfi\n',
    ],
  ])("caches %s as ambiguous", async (_label, content) => {
    const wrapperPath = await wrapper(content);
    const readFile = vi.spyOn(fs, "readFile");

    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).rejects.toThrow(
      "configure channels.imessage.remoteHost explicitly",
    );
    expect(readFile).toHaveBeenCalledOnce();
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBeUndefined();
  });

  it("lets explicit remoteHost override an ambiguous wrapper without reading it", async () => {
    const wrapperPath = await wrapper(
      '#!/bin/sh\nexec ssh -J jump@bastion bot@messages-mac imsg "$@"\n',
    );
    const readFile = vi.spyOn(fs, "readFile");

    const params = { cliPath: wrapperPath, remoteHost: "bot@messages-mac" };
    await expect(resolveIMessageRemoteHost(params)).resolves.toBe("bot@messages-mac");
    expect(readFile).not.toHaveBeenCalled();
    expect(getCachedIMessageRemoteHost(params)).toBe("bot@messages-mac");
  });

  it("returns undefined when the wrapper does not exist", async () => {
    const missingWrapper = path.join(os.tmpdir(), `openclaw-imessage-missing-${randomUUID()}`);

    await expect(resolveIMessageRemoteHost({ cliPath: missingWrapper })).resolves.toBeUndefined();
  });

  it("coalesces concurrent wrapper reads and keys the cache by expanded cliPath", async () => {
    const home = await tempDir();
    vi.stubEnv("HOME", home);
    const wrapperPath = await wrapper(
      '#!/bin/sh\nexec ssh bot@messages-mac imsg "$@"\n',
      path.join(home, ".openclaw"),
    );
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      Promise.all([
        resolveIMessageRemoteHost({ cliPath: "~/.openclaw/imsg-remote" }),
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
      ]),
    ).resolves.toEqual(["bot@messages-mac", "bot@messages-mac"]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(getCachedIMessageRemoteHost({ cliPath: wrapperPath })).toBe("bot@messages-mac");

    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec ssh changed@other-mac imsg "$@"\n');
    await expect(resolveIMessageRemoteHost({ cliPath: wrapperPath })).resolves.toBe(
      "bot@messages-mac",
    );
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("caches a non-SSH wrapper as local across concurrent callers", async () => {
    const wrapperPath = await wrapper('#!/bin/sh\nexec /opt/homebrew/bin/imsg "$@"\n');
    const readFile = vi.spyOn(fs, "readFile");

    await expect(
      Promise.all([
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
        resolveIMessageRemoteHost({ cliPath: wrapperPath }),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("never resolves a remote dbPath against the Gateway home", () => {
    vi.stubEnv("HOME", "/Users/gateway");
    const params = { cliPath: "imsg", dbPath: "~/Library/Messages/chat.db" };
    expect(
      resolveIMessageChatDbLookupPath({
        ...params,
        cliPath: "/gateway/imsg-ssh",
        remoteHost: "messages-mac",
      }),
    ).toBeUndefined();
    expect(resolveIMessageChatDbLookupPath(params)).toBe("/Users/gateway/Library/Messages/chat.db");
  });
});

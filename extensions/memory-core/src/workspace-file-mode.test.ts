import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { createWorkspaceMemoryFileClient } from "openclaw/plugin-sdk/agent-workspace-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { updateDreamsFile } from "./dreaming-dreams-file.js";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import { serveMemoryFiles } from "./remote/memory-files-worker.js";
import { appendSessionCorpusText } from "./session-ingestion.js";
import { commitMemoryContent } from "./short-term-promotion-memory-write.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();
afterEach(() => vi.restoreAllMocks());

async function publish(workspaceDir: string, workspaceFileMode?: "0660") {
  await updateDreamsFile({
    workspaceDir,
    workspaceFileMode,
    updater: () => ({ content: "# Diary\n", result: undefined }),
  });
  await commitMemoryContent({
    filePath: path.join(workspaceDir, "MEMORY.md"),
    tempPrefix: "memory",
    content: "# Memory\n",
    workspaceFileMode,
  });
  const reports = await writeDailyDreamingPhaseBlock({
    workspaceDir,
    workspaceFileMode,
    phase: "light",
    bodyLines: ["- A useful fact."],
    hasContent: true,
    nowMs: Date.UTC(2026, 9, 30),
    timezone: "UTC",
    storage: { mode: "both", separateReports: true },
  });
  return [
    path.join(workspaceDir, "DREAMS.md"),
    path.join(workspaceDir, "MEMORY.md"),
    reports.reportPath!,
  ];
}

it.skipIf(process.platform === "win32").each([
  [undefined, 0o000, 0o600],
  ["0660", 0o022, 0o640],
  ["0660", 0o077, 0o600],
] as const)(
  "preserves directories and creates named outputs using policy %s and host umask %i",
  async (policy, mask, expected) => {
    const workspace = await createTempWorkspace("workspace-mode-");
    vi.spyOn(process, "umask").mockReturnValue(mask);
    await fs.chmod(workspace, 0o770);
    const sharedDirectories = new Set([workspace]);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (sharedDirectories.has(String(args[0]))) {
        vi.spyOn(handle, "chmod").mockRejectedValue(
          Object.assign(new Error("non-owner directory chmod denied"), { code: "EPERM" }),
        );
      }
      return handle;
    });
    const files = await publish(workspace, policy);
    expect((await fs.stat(workspace)).mode & 0o7777).toBe(0o770);
    const reportParent = path.dirname(files[2]!);
    for (const directory of ["memory", "memory/dreaming", "memory/dreaming/light"]) {
      expect((await fs.stat(path.join(workspace, directory))).mode & 0o7777).toBe(0o700);
    }
    await fs.chmod(reportParent, 0o770);
    sharedDirectories.add(reportParent);
    for (const file of files) {
      expect((await fs.stat(file)).mode & 0o777).toBe(expected);
      await fs.chmod(file, 0o620);
    }
    await publish(workspace, policy);
    expect((await fs.stat(reportParent)).mode & 0o7777).toBe(0o770);
    for (const file of files) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o620);
    }
    const corpus = path.join(workspace, "memory", ".dreams", "session-corpus", "2026-10-30.txt");
    await appendSessionCorpusText(corpus, "private input\n");
    for (const file of [corpus, path.join(workspace, "memory", "2026-10-30.md")]) {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "carries configured policy to the remote host before applying that host's umask",
  async () => {
    const workspace = await createTempWorkspace("remote-workspace-mode-");
    const umask = vi.spyOn(process, "umask").mockReturnValue(0o077);
    const files = createWorkspaceMemoryFileClient({
      workspaceDir: "/gateway/workspace",
      remoteWorkspaceDir: workspace,
      signal: new AbortController().signal,
      subscribe: async () => {},
      request: async (request) => {
        umask.mockReturnValue(0o022);
        const output = new PassThrough();
        await serveMemoryFiles({ workspace, input: Readable.from([request]), output });
        umask.mockReturnValue(0o077);
        return String(output.read());
      },
    });
    await files.maintenance!.writeDreams(
      "/gateway/workspace/DREAMS.md",
      "# Shared\n",
      undefined,
      "0660",
    );
    await files.maintenance!.commitContent({
      filePath: "/gateway/workspace/MEMORY.md",
      tempPrefix: "memory",
      content: "# Shared\n",
      workspaceFileMode: "0660",
    });
    const report = "memory/dreaming/light/2026-10-30.md";
    await files.maintenance!.replaceReport(`/gateway/workspace/${report}`, "# Shared\n", "0660");
    for (const relative of ["DREAMS.md", "MEMORY.md", report]) {
      expect((await fs.stat(path.join(workspace, relative))).mode & 0o777).toBe(0o640);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "snapshots the host umask before awaiting publication",
  async () => {
    const workspaceDir = await createTempWorkspace("workspace-umask-snapshot-");
    const umask = vi.spyOn(process, "umask").mockReturnValue(0o022);
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      umask.mockReturnValue(0o077);
      return await lstat(...args);
    });
    await updateDreamsFile({
      workspaceDir,
      workspaceFileMode: "0660",
      updater: () => ({ content: "# Diary\n", result: undefined }),
    });
    expect((await fs.stat(path.join(workspaceDir, "DREAMS.md"))).mode & 0o777).toBe(0o640);
  },
);

it.skipIf(process.platform !== "linux")(
  "retains inherited named ACL access in the file mask",
  async () => {
    const workspace = await createTempWorkspace("workspace-acl-");
    execFileSync("setfacl", ["-m", "d:u:65534:rwX,d:m::rwx", workspace]);
    vi.spyOn(process, "umask").mockReturnValue(0o007);
    for (const file of await publish(workspace, "0660")) {
      const acl = execFileSync("getfacl", ["-cpn", file], { encoding: "utf8" });
      expect(acl).toContain("user:65534:rwx\t#effective:rw-");
      expect(acl).toContain("mask::rw-");
    }
  },
);

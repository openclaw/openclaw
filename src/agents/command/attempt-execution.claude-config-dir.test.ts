import rawFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NATIVE_HISTORY_AUTHORIZATION_DENIED } from "../../config/sessions/session-history-types.js";
import { cliBackendLog } from "../cli-runner/log.js";
import {
  buildClaudeCliFallbackContextPrelude,
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
} from "./attempt-execution.helpers.js";

// mock-isolation: transcript misses are expected; keep their warnings out of the real CLI logger.
vi.mock("../cli-runner/log.js", () => ({ cliBackendLog: { warn: vi.fn() } }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

describe("Claude transcript root probes", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = tempDirs.make("oc-claude-root-probe-");
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  });
  async function makeWorkspace() {
    return await fs.mkdtemp(path.join(tmpDir, "ws-"));
  }

  it("probes only the configured Claude root for content and orphaned tools", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace());
    const configDir = path.join(tmpDir, "selected Claude");
    const projectKey = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionId = "configured-session";
    const selectedFile = path.join(configDir, "projects", projectKey, `${sessionId}.jsonl`);
    const defaultFile = path.join(tmpDir, ".claude", "projects", projectKey, `${sessionId}.jsonl`);
    for (const [file, content] of [
      [selectedFile, [{ type: "tool_use", id: "unanswered", name: "Read", input: {} }]],
      [defaultFile, [{ type: "text", text: "default-root decoy" }]],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content } })}\n`,
      );
    }
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    try {
      // The ambient Gateway root applies; an explicit homeDir would isolate the probe instead.
      const target = { sessionId, workspaceDir };
      expect(await claudeCliSessionTranscriptHasContent(target)).toBe(true);
      expect(await claudeCliSessionTranscriptHasOrphanedToolUse(target)).toBe(true);
      await fs.unlink(selectedFile);
      expect(await claudeCliSessionTranscriptHasContent(target)).toBe(false);
      expect(await claudeCliSessionTranscriptHasOrphanedToolUse(target)).toBe(false);
    } finally {
      vi.mocked(cliBackendLog.warn).mockClear();
    }
  });

  it("probes the retained child root instead of the Gateway root", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace());
    const projectKey = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
    const sessionId = "retained-session";
    const childRoot = path.join(tmpDir, "child Claude", "projects");
    const gatewayFile = path.join(
      tmpDir,
      "gateway Claude",
      "projects",
      projectKey,
      `${sessionId}.jsonl`,
    );
    const childFile = path.join(childRoot, projectKey, `${sessionId}.jsonl`);
    for (const [file, content] of [
      [childFile, [{ type: "text", text: "child-root history" }]],
      [gatewayFile, [{ type: "tool_use", id: "unanswered", name: "Read", input: {} }]],
    ] as const) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        file,
        `${JSON.stringify({ type: "assistant", message: { role: "assistant", content } })}\n`,
      );
    }
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmpDir, "gateway Claude"));
    const target = { sessionId, workspaceDir, homeDir: tmpDir, projectsRoot: childRoot };
    expect(await claudeCliSessionTranscriptHasContent(target)).toBe(true);
    // The Gateway-root decoy is the only transcript holding an unanswered tool_use.
    expect(await claudeCliSessionTranscriptHasOrphanedToolUse(target)).toBe(false);
  });

  it("rechecks native authority through asynchronous fallback discovery and reads", async () => {
    const workspaceDir = await fs.realpath(await makeWorkspace());
    const projectKey = workspaceDir.replace(/[^a-zA-Z0-9]/g, "-");
    const projectsRoot = path.join(tmpDir, "selected Claude", "projects");
    const sessionId = "fallback-session";
    const file = path.join(projectsRoot, projectKey, `${sessionId}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      [
        { type: "user", uuid: "u1", message: { role: "user", content: "earlier question" } },
        {
          type: "assistant",
          uuid: "a1",
          message: { role: "assistant", content: "native fallback answer" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    let authorized = true;
    let checks = 0;
    const build = () =>
      buildClaudeCliFallbackContextPrelude({
        cliSessionId: sessionId,
        cwd: workspaceDir,
        projectsRoot,
        assertNativeHistoryAuthorized: async () => {
          checks += 1;
          if (!authorized) {
            throw new Error(NATIVE_HISTORY_AUTHORIZATION_DENIED);
          }
        },
      });
    expect(await build()).toContain("native fallback answer");
    const allowedChecks = checks;
    expect(allowedChecks).toBeGreaterThanOrEqual(3);

    // Revoked while directory discovery is pending: no file access or read follows.
    const originalReaddir = rawFs.promises.readdir.bind(rawFs.promises);
    const readdir = vi.spyOn(rawFs.promises, "readdir").mockImplementationOnce(async (...args) => {
      const entries = await originalReaddir(...args);
      authorized = false;
      return entries;
    });
    const readFile = vi.spyOn(rawFs.promises, "readFile");
    try {
      await expect(build()).rejects.toThrow(NATIVE_HISTORY_AUTHORIZATION_DENIED);
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      readdir.mockRestore();
      readFile.mockRestore();
    }

    // Revoked after the transcript was read: its content never becomes a prelude.
    authorized = true;
    const originalReadFile = rawFs.promises.readFile.bind(rawFs.promises);
    const lateReadFile = vi
      .spyOn(rawFs.promises, "readFile")
      .mockImplementationOnce(async (...args) => {
        const content = await originalReadFile(...args);
        authorized = false;
        return content;
      });
    try {
      await expect(build()).rejects.toThrow(NATIVE_HISTORY_AUTHORIZATION_DENIED);
    } finally {
      lateReadFile.mockRestore();
    }
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cliBackendLog } from "../cli-runner/log.js";
import {
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
      await fs.writeFile(file, `${JSON.stringify({ message: { role: "assistant", content } })}\n`);
    }
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
    try {
      const target = { sessionId, workspaceDir, homeDir: tmpDir };
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
      await fs.writeFile(file, `${JSON.stringify({ message: { role: "assistant", content } })}\n`);
    }
    vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(tmpDir, "gateway Claude"));
    const target = { sessionId, workspaceDir, homeDir: tmpDir, projectsRoot: childRoot };
    expect(await claudeCliSessionTranscriptHasContent(target)).toBe(true);
    // The Gateway-root decoy is the only transcript holding an unanswered tool_use.
    expect(await claudeCliSessionTranscriptHasOrphanedToolUse(target)).toBe(false);
  });
});

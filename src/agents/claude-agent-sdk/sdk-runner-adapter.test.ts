import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("./sdk-runner.js", () => ({
  runSdkAgent: vi.fn(),
}));

import { runSdkAgent } from "./sdk-runner.js";
import { runSdkAgentAdapted } from "./sdk-runner-adapter.js";

const mockRunSdkAgent = vi.mocked(runSdkAgent);

describe("runSdkAgentAdapted", () => {
  it("appends user/assistant turns to the session transcript", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-adapter-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");

    try {
      mockRunSdkAgent.mockResolvedValue({
        payloads: [{ text: "Assistant reply" }],
        meta: {
          durationMs: 1,
          eventCount: 0,
          extractedChars: 0,
          truncated: false,
          provider: "mock-provider",
          model: "mock-model",
        },
      });

      const result = await runSdkAgentAdapted({
        sessionId: "s1",
        sessionFile,
        workspaceDir: tmpDir,
        prompt: "User prompt",
        timeoutMs: 10_000,
        runId: "r1",
        tools: [],
      });

      expect(result.payloads[0]?.text).toBe("Assistant reply");

      const lines = fs
        .readFileSync(sessionFile, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

      expect(lines).toHaveLength(2);
      const user = JSON.parse(lines[0]!) as { role?: string; content?: unknown };
      const assistant = JSON.parse(lines[1]!) as { role?: string; content?: unknown };

      expect(user.role).toBe("user");
      expect(assistant.role).toBe("assistant");
      expect(JSON.stringify(user.content)).toContain("User prompt");
      expect(JSON.stringify(assistant.content)).toContain("Assistant reply");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

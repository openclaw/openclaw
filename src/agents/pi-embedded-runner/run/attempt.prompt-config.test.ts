import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

function createAttemptParams(workspaceDir: string) {
  return {
    sessionId: "session-prompt-config",
    sessionKey: "agent:main",
    sessionFile: path.join(workspaceDir, "session.json"),
    workspaceDir,
    prompt: "run the helper",
    timeoutMs: 30_000,
    runId: "run-prompt-config",
    provider: "openai",
    modelId: "gpt-5.4",
    model: {
      api: "responses",
      provider: "openai",
      id: "gpt-5.4",
      input: ["text"],
      contextWindow: 128_000,
    } as Model<Api>,
    authStorage: {} as AuthStorage,
    modelRegistry: {} as ModelRegistry,
    thinkLevel: "off" as const,
    senderIsOwner: true,
    disableMessageTool: true,
    contextTokenBudget: 2048,
    toolsAllow: ["exec"],
    config: {
      agents: {
        list: [
          {
            id: "main",
            systemPrompt: {
              mode: "none" as const,
            },
          },
        ],
      },
    },
  };
}

describe("runEmbeddedAttempt prompt config forwarding", () => {
  it("keeps tool-limited runs pinned to minimal prompt mode", async () => {
    vi.resetModules();

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-prompt-"));
    const stop = new Error("stop after prompt build");
    const capturedPromptModes: unknown[] = [];

    try {
      vi.doMock("../system-prompt.js", async () => {
        const actual =
          await vi.importActual<typeof import("../system-prompt.js")>("../system-prompt.js");
        return {
          ...actual,
          buildEmbeddedSystemPrompt: vi.fn((params: { promptMode?: unknown }) => {
            capturedPromptModes.push(params.promptMode);
            throw stop;
          }),
        };
      });

      const { runEmbeddedAttempt } = await import("./attempt.js");

      await expect(runEmbeddedAttempt(createAttemptParams(workspaceDir))).rejects.toBe(stop);

      expect(capturedPromptModes).toEqual(["minimal"]);
    } finally {
      vi.doUnmock("../system-prompt.js");
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

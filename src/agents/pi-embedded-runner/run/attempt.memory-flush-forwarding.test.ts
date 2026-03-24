import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

describe("runEmbeddedAttempt memory flush tool forwarding", () => {
  it("forwards memory trigger metadata into tool creation so append-only guards activate", async () => {
    vi.resetModules();

    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attempt-memory-flush-"));
    const stop = new Error("stop after tool creation");
    const capturedOptions: Array<Record<string, unknown> | undefined> = [];

    try {
      vi.doMock("../../pi-tools.js", async () => {
        const actual =
          await vi.importActual<typeof import("../../pi-tools.js")>("../../pi-tools.js");
        return {
          ...actual,
          createOpenClawCodingTools: vi.fn((options) => {
            capturedOptions.push(options as Record<string, unknown> | undefined);
            throw stop;
          }),
        };
      });

      const { runEmbeddedAttempt } = await import("./attempt.js");

      await expect(
        runEmbeddedAttempt({
          sessionId: "session-memory-flush",
          sessionKey: "agent:main",
          sessionFile: path.join(workspaceDir, "session.json"),
          workspaceDir,
          prompt: "flush durable notes",
          timeoutMs: 30_000,
          runId: "run-memory-flush",
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
          thinkLevel: "off",
          trigger: "memory",
          memoryFlushWritePath: "memory/2026-03-24.md",
        }),
      ).rejects.toBe(stop);

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0]).toMatchObject({
        trigger: "memory",
        memoryFlushWritePath: "memory/2026-03-24.md",
      });
    } finally {
      vi.doUnmock("../../pi-tools.js");
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

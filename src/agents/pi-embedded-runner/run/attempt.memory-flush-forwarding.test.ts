import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const MEMORY_RELATIVE_PATH = "memory/2026-03-24.md";

function createAttemptParams(workspaceDir: string) {
  return {
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
    thinkLevel: "off" as const,
    trigger: "memory" as const,
    memoryFlushWritePath: MEMORY_RELATIVE_PATH,
  };
}

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

      await expect(runEmbeddedAttempt(createAttemptParams(workspaceDir))).rejects.toBe(stop);

      expect(capturedOptions).toHaveLength(1);
      expect(capturedOptions[0]).toMatchObject({
        trigger: "memory",
        memoryFlushWritePath: MEMORY_RELATIVE_PATH,
      });
    } finally {
      vi.doUnmock("../../pi-tools.js");
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps the forwarded memory flush write tool append-only", async () => {
    vi.resetModules();

    const workspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-attempt-memory-flush-append-"),
    );
    const memoryFile = path.join(workspaceDir, MEMORY_RELATIVE_PATH);
    const stop = new Error("stop after append-only write check");
    let appendOnlyWrite: Promise<unknown> | undefined;

    try {
      await fs.mkdir(path.dirname(memoryFile), { recursive: true });
      await fs.writeFile(memoryFile, "seed", "utf-8");

      vi.doMock("../../pi-tools.js", async () => {
        const actual =
          await vi.importActual<typeof import("../../pi-tools.js")>("../../pi-tools.js");
        return {
          ...actual,
          createOpenClawCodingTools: vi.fn((options) => {
            const tools = actual.createOpenClawCodingTools(options);
            const writeTool = tools.find((tool) => tool.name === "write");
            expect(writeTool).toBeDefined();

            appendOnlyWrite = writeTool!.execute("call-memory-flush", {
              path: MEMORY_RELATIVE_PATH,
              content: "new durable note",
            });

            throw stop;
          }),
        };
      });

      const { runEmbeddedAttempt } = await import("./attempt.js");

      await expect(runEmbeddedAttempt(createAttemptParams(workspaceDir))).rejects.toBe(stop);
      await expect(appendOnlyWrite).resolves.toBeDefined();
      await expect(fs.readFile(memoryFile, "utf-8")).resolves.toBe("seed\nnew durable note");
    } finally {
      vi.doUnmock("../../pi-tools.js");
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

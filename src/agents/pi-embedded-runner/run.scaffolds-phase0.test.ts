import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "../test-helpers/fast-coding-tools.js";
import type { OpenClawConfig } from "../../config/config.js";
import { ensureOpenClawModelsJson } from "../models-config.js";

vi.mock("../../scaffolds/index.js", () => {
  return {
    applyEmbeddedRunScaffolds: vi.fn(({ payloads }) =>
      payloads.map((p: { text?: string }) => ({
        ...p,
        text: p.text ? `${p.text} [scaffolded]` : p.text,
      })),
    ),
  };
});

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai")>("@mariozechner/pi-ai");

  const buildAssistantMessage = (model: { api: string; provider: string; id: string }) => ({
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "ok" }],
    stopReason: "stop" as const,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    timestamp: Date.now(),
  });

  return {
    ...actual,
    complete: async (model: { api: string; provider: string; id: string }) =>
      buildAssistantMessage(model),
    completeSimple: async (model: { api: string; provider: string; id: string }) =>
      buildAssistantMessage(model),
    streamSimple: (model: { api: string; provider: string; id: string }) => {
      const stream = new actual.AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: buildAssistantMessage(model) });
        stream.end();
      });
      return stream;
    },
  };
});

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
let tempRoot: string | undefined;
let agentDir: string;
let workspaceDir: string;
let sessionCounter = 0;

beforeAll(async () => {
  vi.useRealTimers();
  ({ runEmbeddedPiAgent } = await import("./run.js"));
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-scaffolds-phase0-"));
  agentDir = path.join(tempRoot, "agent");
  workspaceDir = path.join(tempRoot, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
}, 20_000);

afterAll(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

const nextSessionFile = () => {
  sessionCounter += 1;
  return path.join(workspaceDir, `session-${sessionCounter}.jsonl`);
};

const immediateEnqueue = async <T>(task: () => Promise<T>) => task();

const makeOpenAiConfig = (): OpenClawConfig =>
  ({
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          apiKey: "sk-test",
          baseUrl: "https://example.com",
          models: [
            {
              id: "mock-1",
              name: "Mock",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
    scaffolds: {
      reasoning: {
        enabled: true,
        phase: 0,
      },
    },
  }) as unknown as OpenClawConfig;

describe("runEmbeddedPiAgent scaffolds (phase 0)", () => {
  it("runs payloads through scaffold adapter after buildEmbeddedRunPayloads", async () => {
    const cfg = makeOpenAiConfig();
    await ensureOpenClawModelsJson(cfg, agentDir);

    const sessionFile = nextSessionFile();
    const result = await runEmbeddedPiAgent({
      sessionId: "session:test",
      sessionKey: "agent:test:scaffolds",
      sessionFile,
      workspaceDir,
      config: cfg,
      prompt: "hi",
      provider: "openai",
      model: "mock-1",
      timeoutMs: 5_000,
      agentDir,
      enqueue: immediateEnqueue,
    });

    expect(result.payloads?.[0]?.text).toBe("ok [scaffolded]");
  });
});

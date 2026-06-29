// Integration: the REAL production wiring — buildEmbeddedExtensionFactories gates +
// registers the capture extension, and firing the runner's agent_end event writes a
// durable turn. This is the creds-free equivalent of a live gateway turn: it exercises
// the exact factory->agent_end->capture->per-agent-DB path (only the upstream model
// token stream, which capture is indifferent to, is absent).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import type { AgentMessage } from "../runtime/index.js";
import type { AgentEndEvent, ExtensionAPI } from "../sessions/index.js";
import { getTurns } from "./turns-store.js";

const SESSION_KEY = "agent:main:main";
let priorStateDir: string | undefined;
let stateDir: string;

function buildParams(cfg: OpenClawConfig, withScope: boolean) {
  return {
    cfg,
    sessionManager: {} as never,
    provider: "openai",
    modelId: "gpt-5.5",
    model: undefined,
    ...(withScope ? { agentId: "main", sessionKey: SESSION_KEY } : {}),
  } as Parameters<typeof buildEmbeddedExtensionFactories>[0];
}

function collectAgentEndHandlers(factories: ReturnType<typeof buildEmbeddedExtensionFactories>) {
  const handlers: Array<(event: AgentEndEvent) => unknown> = [];
  const api = {
    on: (event: string, handler: (event: AgentEndEvent) => unknown) => {
      if (event === "agent_end") {
        handlers.push(handler);
      }
    },
  } as unknown as ExtensionAPI;
  for (const factory of factories) {
    factory(api);
  }
  return handlers;
}

const enabledCfg = {
  agents: { defaults: { conversationalMemory: { enabled: true } } },
} as OpenClawConfig;

const sampleTurn = [
  { role: "user", content: [{ type: "text", text: "set up voice" }], timestamp: 1 },
  {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId: "resp-1",
    usage: {} as never,
    stopReason: "stop",
    timestamp: 2,
  },
] as AgentMessage[];

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-capture-int-"));
  // The capture extension writes via the default state dir (production has no env
  // override); point it at a temp dir for the test.
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("conversational-memory capture wiring (02-01 live-equivalent)", () => {
  it("registers a capture extension and persists a turn on agent_end when enabled", async () => {
    const handlers = collectAgentEndHandlers(
      buildEmbeddedExtensionFactories(buildParams(enabledCfg, true)),
    );
    expect(handlers).toHaveLength(1);

    await handlers[0]!({ type: "agent_end", messages: sampleTurn });

    const stored = getTurns({ agentId: "main", sessionKey: SESSION_KEY });
    expect(stored.map((t) => t.content)).toEqual(["set up voice", "Done."]);
    expect(stored.map((t) => t.seq)).toEqual([1, 2]);
  });

  it("registers NO capture extension when the feature is disabled (default)", () => {
    const handlers = collectAgentEndHandlers(
      buildEmbeddedExtensionFactories(buildParams({} as OpenClawConfig, true)),
    );
    expect(handlers).toHaveLength(0);
  });

  it("registers NO capture extension when agentId/sessionKey are absent (e.g. compaction runs)", () => {
    const handlers = collectAgentEndHandlers(
      buildEmbeddedExtensionFactories(buildParams(enabledCfg, false)),
    );
    expect(handlers).toHaveLength(0);
  });
});

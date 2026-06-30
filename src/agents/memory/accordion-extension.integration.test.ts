// Integration (02-02): the real context-hook path. Seed turns/spans/boxes, build the
// production extension factories, run the registered "context" handler, and assert a
// collapsed box folds in place (summary once) and flipping it back to live restores
// verbatim context — proving collapse/expand via boxes.state without mutating turns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import type { AgentMessage } from "../runtime/index.js";
import type { ContextEvent, ExtensionAPI } from "../sessions/index.js";
import { FOLDED_MARKER } from "./accordion-seq-walk.js";
import { buildCapturedTurns } from "./turns-capture.js";
import { appendTurns, setBoxState, upsertBox, upsertSpan } from "./turns-store.js";

const AGENT = "main";
const SESSION_KEY = "agent:main:main";
let priorStateDir: string | undefined;

function user(ts: number, text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts } as AgentMessage;
}
function assistant(responseId: string, text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId,
    usage: {} as never,
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
}

const enabledCfg = {
  agents: { defaults: { conversationalMemory: { enabled: true } } },
} as OpenClawConfig;

/** Run every registered "context" handler in order, threading messages (mimics emitContext). */
function runContext(messages: AgentMessage[], cfg: OpenClawConfig = enabledCfg): AgentMessage[] {
  const handlers: Array<(event: ContextEvent) => { messages?: AgentMessage[] } | undefined> = [];
  const api = {
    on: (
      event: string,
      handler: (event: ContextEvent) => { messages?: AgentMessage[] } | undefined,
    ) => {
      if (event === "context") {
        handlers.push(handler);
      }
    },
  } as unknown as ExtensionAPI;
  const factories = buildEmbeddedExtensionFactories({
    cfg,
    sessionManager: {} as never,
    provider: "openai",
    modelId: "gpt-5.5",
    model: undefined,
    agentId: AGENT,
    sessionKey: SESSION_KEY,
  } as Parameters<typeof buildEmbeddedExtensionFactories>[0]);
  for (const factory of factories) {
    factory(api);
  }
  let current = messages;
  for (const handler of handlers) {
    const result = handler({ type: "context", messages: current });
    if (result?.messages) {
      current = result.messages;
    }
  }
  return current;
}

const textAt = (msgs: AgentMessage[], i: number): string =>
  (msgs[i] as { content: { text: string }[] }).content[0]?.text;

beforeEach(() => {
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), "openclaw-accordion-int-"),
  );
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
});

describe("accordion context extension (02-02 collapse/expand)", () => {
  const messages = [user(1, "voice question"), assistant("r1", "voice answer")];

  function seedBox(state: "live" | "collapsed"): void {
    // Seed the turns directly rather than via captureConversationTurns: since Phase 3,
    // capture also runs auto-segmentation, which would create its own competing spans/boxes
    // over these seqs. This test pins one explicit span→box to prove the context-fold path
    // in isolation, so it must be the only span covering seq 1,2.
    appendTurns({
      agentId: AGENT,
      sessionKey: SESSION_KEY,
      turns: buildCapturedTurns(SESSION_KEY, messages),
    }); // turns seq 1,2
    upsertSpan({
      agentId: AGENT,
      span: { spanId: "s1", sessionKey: SESSION_KEY, startSeq: 1, endSeq: 2, boxId: "box-voice" },
    });
    upsertBox({
      agentId: AGENT,
      box: { boxId: "box-voice", sessionKey: SESSION_KEY, summary: "Voice setup summary", state },
    });
  }

  it("passes context through verbatim when the box is live (ACCD-01)", () => {
    seedBox("live");
    const out = runContext(messages);
    expect(out.map((_, i) => textAt(out, i))).toEqual(["voice question", "voice answer"]);
  });

  it("folds a collapsed box to its summary once, then restores verbatim on expand (ACCD-01)", () => {
    seedBox("collapsed");
    const folded = runContext(messages);
    expect(textAt(folded, 0)).toBe("Voice setup summary"); // summary emitted once
    expect(textAt(folded, 1)).toBe(FOLDED_MARKER); // rest of the box → marker
    expect(folded).toHaveLength(2); // turns not removed; positions preserved

    // Expand: flip state only — turns were never mutated, so verbatim returns exactly.
    setBoxState({ agentId: AGENT, boxId: "box-voice", state: "live" });
    const restored = runContext(messages);
    expect(restored.map((_, i) => textAt(restored, i))).toEqual(["voice question", "voice answer"]);
  });

  it("leaves context verbatim when conversationalMemory is disabled, even with a collapsed box", () => {
    seedBox("collapsed");
    // Feature off → no accordion context handler registered → the collapsed box is ignored.
    const out = runContext(messages, {} as OpenClawConfig);
    expect(out.map((_, i) => textAt(out, i))).toEqual(["voice question", "voice answer"]);
  });
});

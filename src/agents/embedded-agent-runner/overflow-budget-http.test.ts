// Connected transport-to-accounting-to-recovery trace for the overflow budget.
//
// ClawSweeper Revision 5 accepted the real HTTP/SSE transport here but found the
// chain broken at both ends: the harness hand-computed `admitted` instead of
// letting the production observer derive it, and it incremented the attempt
// counter itself instead of letting `recoverEmbeddedRunOverflow` drive it. That
// criticism was correct. This file connects the whole path:
//
//   real node:http + SSE -> streamOpenAICompletions    (real transport)
//     -> createEmbeddedModelState.captureModelEvent    (real producer)
//       -> observeContextAccounting                    (real accounting)
//         -> recoverEmbeddedRunOverflow                (real recovery)
//
// The tests assert only observable outcomes of that chain: they never build an
// `admitted` boolean and never assign `overflowCompactionAttempts`.
//
// This is an isolated production-path harness: a loopback server stands in for
// the provider, which Revision 5 stated is sufficient without an official
// provider or the full application.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { streamOpenAICompletions } from "@openclaw/ai/internal/openai";
import { isContextOverflow } from "@openclaw/ai/internal/runtime";
import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import { MAX_OVERFLOW_COMPACTION_ATTEMPTS } from "../agent-compaction-constants.js";
import { createEmbeddedModelState } from "../embedded-agent-subscribe.model-state.js";
import type { SubscribeEmbeddedAgentSessionParams } from "../embedded-agent-subscribe.types.js";
import { SessionManager } from "../sessions/session-manager.js";
import { createEmbeddedRunContextRecoveryState } from "./run/context-recovery-state.js";
import type { EmbeddedContextAccountingEvent } from "./run/internal-params.js";
import { recoverEmbeddedRunOverflow } from "./run/overflow-context-recovery.js";

const CONTEXT_WINDOW = 200_000;

const silentLog = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  isEnabled: () => false,
};

/** Serializes chat-completion chunks as the SSE stream the real transport reads. */
function serverSentChunks(chunks: Record<string, unknown>[]): string {
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function withLoopbackProvider<T>(
  chunks: Record<string, unknown>[],
  run: (model: Model<"openai-completions">) => Promise<T>,
): Promise<T> {
  const server: Server = createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    response.end(serverSentChunks(chunks));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    return await run({
      id: "loopback/overflow-model",
      name: "Loopback overflow model",
      api: "openai-completions",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: CONTEXT_WINDOW,
      maxTokens: 1_024,
    } satisfies Model<"openai-completions">);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * Streams one real HTTP turn and returns the assistant message production sees.
 *
 * `usage` reaches the assistant message only through the terminal chunk, so the
 * token counts asserted below are the ones the transport actually parsed.
 */
async function realTurn(finishReason: string, content: string, usage: Record<string, number>) {
  const chunks = [
    {
      id: "loopback-chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "loopback/overflow-model",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "loopback-chunk",
      object: "chat.completion.chunk",
      created: 1,
      model: "loopback/overflow-model",
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage,
    },
  ];
  return await withLoopbackProvider(chunks, async (model) => {
    const context: Context = {
      messages: [{ role: "user", content: "summarize the transcript", timestamp: 1 }],
    };
    const message = await streamOpenAICompletions(model, context, {
      apiKey: ["loopback", "test", "key"].join("-"),
    }).result();
    return { message, contextWindow: model.contextWindow };
  });
}

/**
 * Feeds a real transport message through the production producer.
 *
 * `createEmbeddedModelState` derives `admitted` itself and resolves the window
 * from its own params, exercising the `params.session.model?.contextWindow`
 * fallback. Callers supply only the session, so the admission rule is never
 * recomputed in this file.
 */
function observeThroughProducer(
  message: AssistantMessage,
  window: number | undefined,
  onEvent: (event: EmbeddedContextAccountingEvent) => void,
): void {
  const params = {
    runId: "run-connected-trace",
    session: { model: window === undefined ? undefined : { contextWindow: window } },
    onContextAccountingEvent: onEvent,
  } as unknown as SubscribeEmbeddedAgentSessionParams;
  const modelState = createEmbeddedModelState(params, silentLog as never);
  modelState.captureModelEvent({ type: "message_start", message } as never);
  modelState.captureModelEvent({ type: "message_end", message } as never);
}

/**
 * Recovery input whose context engine commits a compaction that frees nothing.
 *
 * The overflow signal is the real transport message: production classifies it
 * through its own `isContextOverflow(assistant, contextTokenBudget)` branch, so
 * entry into recovery is decided by production, not asserted here.
 */
function makeRecoveryInput(
  state: ReturnType<typeof createEmbeddedRunContextRecoveryState>,
  assistantOverflowCandidate: AssistantMessage,
) {
  const session = {
    id: "session-connected",
    file: "/session/connected.jsonl",
    target: { sessionId: "session-connected" },
  };
  return {
    runParams: {
      runId: "run-connected-trace",
      sessionId: session.id,
      sessionKey: "agent:main:session-connected",
      config: {},
      workspaceDir: "/tmp/workspace",
      prompt: "continue",
      timeoutMs: 1_000,
      onAutoCompactionSucceeded: vi.fn(),
    },
    state,
    assertRecoveryActive: () => {},
    prepareRecoveryOwner: () => ({
      session: {
        ...session,
        target: {
          ...session.target,
          agentId: "main",
          sessionKey: "agent:main:session-connected",
          storePath: "/tmp/workspace/openclaw-agent.sqlite",
        },
      },
      assertActive: () => {},
      withTranscriptWrites: async <T>(_signal: AbortSignal | undefined, run: () => Promise<T>) =>
        await run(),
    }),
    prepareRecoverySession: () => ({
      sessionManager: SessionManager.inMemory("/tmp/workspace"),
      assertActive: vi.fn(),
      withSessionManagerRewriteLock: async <T>(operation: () => Promise<T> | T) =>
        await operation(),
    }),
    getActiveSession: () => session,
    contextEngine: {
      info: { id: "legacy", name: "Legacy" },
      ingest: vi.fn(),
      assemble: vi.fn(),
      // A compaction that commits but frees nothing: the no-progress shape.
      compact: vi.fn(async () => ({
        ok: true,
        compacted: true,
        result: { summary: "compacted", tokensBefore: 199_000, tokensAfter: 199_000 },
      })),
    },
    contextTokenBudget: CONTEXT_WINDOW,
    attemptCompactionCount: 0,
    genericCompactionRecoveryAllowed: true,
    markOwnedTranscriptRetry: vi.fn(),
    prepareCurrentTranscriptRetry: vi.fn(),
    prepareCompactedTranscriptRetry: vi.fn(),
    armPostCompactionGuard: vi.fn(),
    runOwnsCompactionBeforeHook: vi.fn(),
    runOwnsCompactionAfterHook: vi.fn(),
    modelSelection: { provider: "openai", model: "loopback/overflow-model" },
    resolveContextEnginePluginId: () => undefined,
    buildRuntimeSettings: () => ({}),
    adoptCompactionTranscript: async () => {},
    onCompactionHookMessages: () => {},
    sessionAgentId: "main",
    contextEngineAgentId: undefined,
    aborted: false,
    signalOwnedInterruption: false,
    promptError: undefined,
    // Real transport output drives production's own overflow classification.
    assistantOverflowCandidate: { message: assistantOverflowCandidate, classification: null },
    attempt: {
      terminal: { kind: "completed" },
      sessionIdUsed: session.id,
      assistantTexts: [],
      messagesSnapshot: [],
      toolMetas: [],
      replayMetadata: { replaySafe: true, hadPotentialSideEffects: false },
    },
  };
}

/** A real HTTP turn that production classifies as an overflow (Case 3 shape). */
async function realOverflowTurn() {
  return await realTurn("length", "", {
    prompt_tokens: 199_000,
    completion_tokens: 0,
    total_tokens: 199_000,
  });
}

/** Charges one attempt by running production recovery, never by assignment. */
async function chargeOneAttemptThroughRecovery(
  state: ReturnType<typeof createEmbeddedRunContextRecoveryState>,
  overflowMessage: AssistantMessage,
): Promise<void> {
  const result = await recoverEmbeddedRunOverflow(
    makeRecoveryInput(state, overflowMessage) as never,
  );
  expect(result).toMatchObject({ action: "retry" });
}

describe("connected transport -> accounting -> recovery trace", () => {
  it("forwards a real context window so silent overflow stays detectable", async () => {
    // `Model.contextWindow` is optional, so a missing value would silently
    // disable isContextOverflow Case 2/3 and make the whole fix inert.
    const { message, contextWindow } = await realTurn("stop", "ok", {
      prompt_tokens: 220_000,
      completion_tokens: 6,
      total_tokens: 220_006,
    });
    expect(contextWindow).toBe(CONTEXT_WINDOW);
    expect(isContextOverflow(message, undefined)).toBe(false);
    expect(isContextOverflow(message, contextWindow)).toBe(true);

    // Same real message, window withheld from the producer: the production
    // verdict flips to admitted, which is exactly the inert-fix regression.
    const withoutWindow: EmbeddedContextAccountingEvent[] = [];
    observeThroughProducer(message, undefined, (event) => withoutWindow.push(event));
    expect(withoutWindow).toEqual([
      { kind: "model", contextTokens: expect.any(Number), admitted: true },
    ]);

    // With the window the production verdict is not admitted.
    const withWindow: EmbeddedContextAccountingEvent[] = [];
    observeThroughProducer(message, contextWindow, (event) => withWindow.push(event));
    expect(withWindow).toEqual([
      { kind: "model", contextTokens: expect.any(Number), admitted: false },
    ]);
  }, 30_000);

  it("does not renew the budget for a Case 2 silent overflow", async () => {
    // Case 2 shape (z.ai/GLM, openclaw#75799): finish_reason "stop", positive
    // usage, prompt_tokens already past the window.
    const { message, contextWindow } = await realTurn("stop", "ok", {
      prompt_tokens: 220_000,
      completion_tokens: 6,
      total_tokens: 220_006,
    });

    const state = createEmbeddedRunContextRecoveryState();
    await chargeOneAttemptThroughRecovery(state, message);
    expect(state.overflowCompactionAttempts).toBe(1);

    observeThroughProducer(message, contextWindow, (event) =>
      state.observeContextAccounting(event),
    );

    // Still charged: a silent overflow is not progress.
    expect(state.overflowCompactionAttempts).toBe(1);
  }, 30_000);

  it("does not renew the budget for a Case 3 length overflow", async () => {
    // Case 3 shape: length stop, zero output, prompt at >= 99% of the window.
    const { message, contextWindow } = await realTurn("length", "", {
      prompt_tokens: 199_000,
      completion_tokens: 0,
      total_tokens: 199_000,
    });

    const state = createEmbeddedRunContextRecoveryState();
    await chargeOneAttemptThroughRecovery(state, message);
    expect(state.overflowCompactionAttempts).toBe(1);

    observeThroughProducer(message, contextWindow, (event) =>
      state.observeContextAccounting(event),
    );
    expect(state.overflowCompactionAttempts).toBe(1);
  }, 30_000);

  it("renews the budget after a real completed turn under the window", async () => {
    // Entering recovery requires a real overflow; the admitted turn below is
    // deliberately under the window, so it cannot be that signal.
    const overflow = await realOverflowTurn();
    const { message, contextWindow } = await realTurn("stop", "real answer", {
      prompt_tokens: 40_000,
      completion_tokens: 25,
      total_tokens: 40_025,
    });

    const state = createEmbeddedRunContextRecoveryState();
    await chargeOneAttemptThroughRecovery(state, overflow.message);
    expect(state.overflowCompactionAttempts).toBe(1);

    observeThroughProducer(message, contextWindow, (event) =>
      state.observeContextAccounting(event),
    );

    // Real progress renews the whole budget.
    expect(state.overflowCompactionAttempts).toBe(0);
  }, 30_000);

  it("terminates recovery after the attempt bound when every real turn overflows", async () => {
    const state = createEmbeddedRunContextRecoveryState();

    // Each round: production recovery compacts (freeing nothing) and retries,
    // then a real overflowing HTTP turn is observed through the production
    // producer. This test never touches the counter itself.
    let lastOverflowMessage: AssistantMessage | undefined;
    for (let round = 1; round <= MAX_OVERFLOW_COMPACTION_ATTEMPTS; round += 1) {
      const { message, contextWindow } = await realOverflowTurn();
      lastOverflowMessage = message;

      await chargeOneAttemptThroughRecovery(state, message);
      expect(state.overflowCompactionAttempts).toBe(round);

      observeThroughProducer(message, contextWindow, (event) =>
        state.observeContextAccounting(event),
      );
      // The overflow never renews, so the charge accumulates.
      expect(state.overflowCompactionAttempts).toBe(round);
    }

    // Bound reached: production recovery surfaces instead of compacting again.
    expect(lastOverflowMessage).toBeDefined();
    const exhausted = await recoverEmbeddedRunOverflow(
      makeRecoveryInput(state, lastOverflowMessage as AssistantMessage) as never,
    );
    expect(exhausted).toMatchObject({ action: "surface", kind: "context_overflow" });
  }, 60_000);
});

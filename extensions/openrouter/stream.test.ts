import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { OPENROUTER_BASE_URL } from "./provider-catalog.js";
import { wrapOpenRouterProviderStream } from "./stream.js";

const SESSION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const OTHER_SESSION_ID = "11111111-1111-1111-1111-111111111111";

type CaseOptions = {
  forwardSessionId?: boolean;
  sessionId?: string;
  provider?: string;
  modelId?: string;
  baseUrl?: string;
  initialPayload?: Record<string, unknown>;
};

function runSessionIdCase(opts: CaseOptions): Record<string, unknown> {
  const provider = opts.provider ?? "openrouter";
  const modelId = opts.modelId ?? "openai/gpt-5.5";
  const model = {
    id: modelId,
    provider,
    api: "openai-completions",
    baseUrl: opts.baseUrl ?? OPENROUTER_BASE_URL,
  } as Parameters<StreamFn>[0];

  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (m, _context, options) => {
    const payload: Record<string, unknown> = { model: m.id, messages: [], ...opts.initialPayload };
    void options?.onPayload?.(payload, m);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const ctx = {
    config: {
      plugins: { entries: { openrouter: { config: { forwardSessionId: opts.forwardSessionId } } } },
    },
    provider,
    modelId,
    model,
    extraParams: {},
    streamFn: baseStreamFn,
  } as unknown as ProviderWrapStreamFnContext;

  const wrapped = wrapOpenRouterProviderStream(ctx);
  void wrapped?.(model, { messages: [] } as Parameters<StreamFn>[1], { sessionId: opts.sessionId });
  return captured;
}

describe("wrapOpenRouterProviderStream session_id forwarding", () => {
  it("injects an opaque, deterministic session_id when enabled and options.sessionId is present", () => {
    const payload = runSessionIdCase({ forwardSessionId: true, sessionId: SESSION_ID });
    expect(payload.session_id).toMatch(/^[0-9a-f]{64}$/);
    expect(payload.session_id).not.toBe(SESSION_ID);

    const again = runSessionIdCase({ forwardSessionId: true, sessionId: SESSION_ID });
    expect(again.session_id).toBe(payload.session_id);
  });

  it("derives a different session_id for a different raw session id", () => {
    const first = runSessionIdCase({ forwardSessionId: true, sessionId: SESSION_ID });
    const second = runSessionIdCase({ forwardSessionId: true, sessionId: OTHER_SESSION_ID });
    expect(first.session_id).not.toBe(second.session_id);
  });

  it("does not inject session_id when forwarding is disabled", () => {
    const payload = runSessionIdCase({ forwardSessionId: false, sessionId: SESSION_ID });
    expect(payload).not.toHaveProperty("session_id");
  });

  it("does not inject session_id when forwarding is unset", () => {
    const payload = runSessionIdCase({ sessionId: SESSION_ID });
    expect(payload).not.toHaveProperty("session_id");
  });

  it("does not inject session_id when no session id is available", () => {
    const payload = runSessionIdCase({ forwardSessionId: true });
    expect(payload).not.toHaveProperty("session_id");
  });

  it("preserves a caller-set session_id", () => {
    const payload = runSessionIdCase({
      forwardSessionId: true,
      sessionId: SESSION_ID,
      initialPayload: { session_id: "caller-value" },
    });
    expect(payload.session_id).toBe("caller-value");
  });

  it("keeps the derived session_id within OpenRouter's 256-character cap for very long raw session ids", () => {
    const longSessionId = "a".repeat(5000);
    const payload = runSessionIdCase({ forwardSessionId: true, sessionId: longSessionId });
    expect(typeof payload.session_id).toBe("string");
    expect((payload.session_id as string).length).toBeLessThanOrEqual(256);
  });

  it("does not inject session_id on a non-OpenRouter route", () => {
    const payload = runSessionIdCase({
      forwardSessionId: true,
      sessionId: SESSION_ID,
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(payload).not.toHaveProperty("session_id");
  });
});

import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { assert, expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { createPromptRequest } from "./translator.bridge-test-helpers.js";
import * as acp from "./translator.test-helpers.js";

type ScenarioOptions = Pick<
  NonNullable<Parameters<typeof acp.createAcpGatewayAgent>[2]>,
  "eventLedger" | "sessionCreateRateLimit" | "provenanceMode"
> & {
  sessions?: string[];
  sessionKey?: string;
  requestPermission?: ReturnType<typeof vi.fn>;
};

export function createTranslatorScenario(
  request: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  {
    sessions = ["session-1"],
    sessionKey = "agent:main:main",
    requestPermission,
    ...options
  }: ScenarioOptions = {},
) {
  const sessionStore = createInMemorySessionStore();
  for (const sessionId of sessions) {
    sessionStore.createSession({ sessionId, sessionKey, cwd: "/tmp" });
  }
  const connection = acp.createAcpConnection({ requestPermission });
  const sessionUpdate = connection["__sessionUpdateMock"];
  const agent = acp.createAcpGatewayAgent(
    connection,
    acp.createAcpGateway(request as GatewayClient["request"]),
    { ...options, sessionStore },
  );
  return { agent, connection, sessionKey, sessionStore, sessionUpdate };
}

export function expectSingleCall(
  source: { mock: { calls: unknown[][] } },
  fields: Record<string, unknown>,
) {
  expect(source.mock.calls).toMatchObject([[fields]]);
}

export function createPromptScenario({
  send = () => new Promise<never>(() => {}),
  request: handleRequest = () => ({}),
  ...options
}: ScenarioOptions & {
  send?: (params?: Record<string, unknown>) => unknown;
  request?: (method: string, params?: Record<string, unknown>) => unknown;
} = {}) {
  const runIds: string[] = [];
  let nextSend = createDeferred<string>();
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    if (method !== "chat.send") {
      return handleRequest(method, params);
    }
    const runId = params?.idempotencyKey;
    assert(typeof runId === "string", "missing Gateway run id");
    runIds.push(runId);
    nextSend.resolve(runId);
    nextSend = createDeferred<string>();
    return send(params);
  });
  const h = createTranslatorScenario(request, options);
  const prompt = (sessionId = "session-1", text = "hello") =>
    h.agent.prompt(createPromptRequest(sessionId, text));
  const start = (...args: Parameters<typeof prompt>) => {
    const sent = nextSend.promise;
    const result = prompt(...args);
    const settlement = vi.fn();
    void result.then(
      (value) => settlement({ kind: "resolve", value }),
      (error: unknown) => settlement({ kind: "reject", error }),
    );
    return { result, sent, settlement };
  };
  const active = async (...args: Parameters<typeof prompt>) => {
    const pending = start(...args);
    return { ...pending, runId: await pending.sent };
  };
  const event = (name: string, fields: Record<string, unknown>) => {
    const payload = { sessionKey: h.sessionKey, seq: 1, ...fields };
    return h.agent.handleGatewayEvent({ type: "event", event: name, payload });
  };
  const chat = (runId: string, payload: Record<string, unknown> = {}) =>
    event("chat", { runId, state: "final", ...payload });
  type PendingPrompt = Pick<ReturnType<typeof start>, "sent" | "result">;
  const finish = async (pending: PendingPrompt, fields: Record<string, unknown> = {}) => {
    await chat(await pending.sent, fields);
    await expect(pending.result).resolves.toEqual({ stopReason: "end_turn" });
  };
  return { ...h, request, runIds, prompt, start, active, event, chat, finish };
}

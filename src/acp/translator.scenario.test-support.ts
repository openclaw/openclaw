import { createInMemorySessionStore } from "@openclaw/acp-core/session";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { GatewayClient } from "../gateway/client.js";
import { observeSettlement, promptAgent } from "./translator.prompt-harness.test-support.js";
import {
  createAcpConnection,
  createAcpGateway,
  createAcpGatewayAgent,
} from "./translator.test-helpers.js";

type ScenarioOptions = Pick<
  NonNullable<Parameters<typeof createAcpGatewayAgent>[2]>,
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
  const connection = createAcpConnection({ requestPermission });
  const sessionUpdate = vi.spyOn(connection, "sessionUpdate");
  const agent = createAcpGatewayAgent(
    connection,
    createAcpGateway(request as GatewayClient["request"]),
    {
      ...options,
      sessionStore,
    },
  );
  return { agent, sessionStore, sessionUpdate };
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
    if (typeof runId !== "string") {
      throw new Error("missing Gateway run id");
    }
    runIds.push(runId);
    nextSend.resolve(runId);
    nextSend = createDeferred<string>();
    return send(params);
  });
  const h = createTranslatorScenario(request, options);
  const prompt = (sessionId = "session-1", text = "hello") => promptAgent(h.agent, sessionId, text);
  const start = (sessionId = "session-1", text = "hello") => {
    const sent = nextSend.promise;
    const result = prompt(sessionId, text);
    return { result, sent, settlement: observeSettlement(result) };
  };
  const active = async (sessionId = "session-1", text = "hello") => {
    const before = runIds.length;
    const pending = start(sessionId, text);
    await vi.waitFor(() => expect(runIds).toHaveLength(before + 1));
    return { ...pending, runId: await pending.sent };
  };
  const event = (name: string, payload: Record<string, unknown>) =>
    h.agent.handleGatewayEvent({
      type: "event",
      event: name,
      payload: { sessionKey: options.sessionKey ?? "agent:main:main", seq: 1, ...payload },
    });
  const chat = (runId: string, payload: Record<string, unknown> = {}) =>
    event("chat", { runId, state: "final", ...payload });
  const finish = async (
    pending: Pick<ReturnType<typeof start>, "sent" | "result">,
    fields: Record<string, unknown> = {},
  ) => {
    await chat(await pending.sent, fields);
    await expect(pending.result).resolves.toEqual({ stopReason: "end_turn" });
  };
  return { ...h, request, runIds, prompt, start, active, event, chat, finish };
}

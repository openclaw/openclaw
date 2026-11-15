import { Value } from "typebox/value";
import { expect, expectTypeOf, it } from "vitest";
import * as P from "./index.js";
import * as S from "./schema.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

it("preserves published worker tool imports without advertising retired RPCs", () => {
  const spawn = { toolCallId: " call ", task: "run" } satisfies P.WorkerSessionsSpawnParams;
  const send = {
    toolCallId: "call",
    sessionKey: "agent:main:child",
    message: "continue",
  } satisfies P.WorkerSessionsSendParams;
  const portal = { toolCallId: "call", action: "open", port: 8080 } satisfies P.WorkerPortalParams;
  const presence = {
    toolCallId: "call",
    action: "person",
    person: "me",
    include: ["devices"],
    limit: 10,
  } satisfies P.WorkerPresenceParams;
  const response = {
    type: "res",
    id: "reply",
    ok: true,
    payload: { resultJson: "{}" } satisfies P.WorkerSessionToolResult,
  } satisfies P.WorkerSessionsSpawnResponseFrame;
  const error = {
    type: "res",
    id: "error",
    ok: false,
    error: { code: "INVALID_REQUEST", message: "invalid", details: { reason: "invalid-frame" } },
  };
  for (const [name, valid, invalid] of [
    ["SessionsSpawn", spawn, { ...spawn, task: "x".repeat(8_193) }],
    ["SessionsSend", send, { ...send, timeoutSeconds: 86_401 }],
    ["Portal", portal, { ...portal, path: "relative" }],
    ["Presence", presence, { ...presence, limit: 101 }],
  ] as const) {
    const params = `Worker${name}Params` as const;
    const validate = P[`validate${params}`];
    expect(validate.schema).toBe(P[`${params}Schema`]);
    expect(validate(valid)).toBe(true);
    expect(validate({ ...valid, extra: true })).toBe(false);
    expect(validate(invalid)).toBe(false);
    expect(validate.errors?.length).toBeGreaterThan(0);
    const frame = `Worker${name}ResponseFrame` as const;
    for (const key of [params, frame]) {
      expect(P[`${key}Schema`]).toBe(S[`${key}Schema`]);
      expect(ProtocolSchemas).not.toHaveProperty(key);
    }
    const schema = P[`${frame}Schema`];
    expect(schema).toBe(S.WorkerSessionToolResponseFrameSchema);
    expect(Value.Check(schema, response)).toBe(true);
    expect(Value.Check(schema, { ...response, payload: { content: [] } })).toBe(false);
    expect(Value.Check(schema, error)).toBe(true);
  }
  expect(P.validateWorkerSessionsSpawnParams({ ...spawn, agentId: " agent " })).toBe(false);
  expect(Value.Check(S.PlacedSessionsSpawnSchema, { task: "run", agentId: " agent " })).toBe(true);
  expect(P.WorkerSessionToolResultSchema).toBe(S.WorkerSessionToolResultSchema);
  expect(ProtocolSchemas).not.toHaveProperty("WorkerSessionToolResult");
  expect([P.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH, S.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH]).toEqual([
    8_192, 8_192,
  ]);
  for (const [name, value] of [
    ["WORKER_SESSION_TOOLS_PROTOCOL_FEATURE", "worker-session-tools-v1"],
    ["WORKER_PORTAL_PROTOCOL_FEATURE", "worker-portal-v1"],
    ["WORKER_PRESENCE_PROTOCOL_FEATURE", "worker-presence-v1"],
  ] as const) {
    expect(P[name]).toBe(value);
    expect(S[name]).toBe(value);
    expect(P.WORKER_PROTOCOL_FEATURES).not.toContain(value);
  }
  for (const method of [
    "worker.sessions.spawn",
    "worker.sessions.send",
    "worker.portal",
    "worker.presence",
  ]) {
    expect(P.WORKER_PROTOCOL_METHODS).not.toContain(method);
  }
  expectTypeOf<P.WorkerSessionsSendResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
  expectTypeOf<P.WorkerPortalResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
  expectTypeOf<P.WorkerPresenceResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
  expectTypeOf<P.WorkerSessionsSpawnParams>().toEqualTypeOf<S.WorkerSessionsSpawnParams>();
  expectTypeOf<P.WorkerSessionsSendParams>().toEqualTypeOf<S.WorkerSessionsSendParams>();
  expectTypeOf<P.WorkerPortalParams>().toEqualTypeOf<S.WorkerPortalParams>();
  expectTypeOf<P.WorkerPresenceParams>().toEqualTypeOf<S.WorkerPresenceParams>();
  expectTypeOf<P.WorkerSessionToolResult>().toEqualTypeOf<S.WorkerSessionToolResult>();
});

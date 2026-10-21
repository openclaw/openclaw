import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as P from "./index.js";
import * as Schema from "./schema.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

describe("released worker tool imports", () => {
  it("preserves published worker tool imports without advertising retired RPCs", () => {
    const spawn = {
      toolCallId: " call ",
      task: "run",
    } satisfies P.WorkerSessionsSpawnParams;
    const send = {
      toolCallId: "call",
      sessionKey: "agent:main:child",
      message: "continue",
    } satisfies P.WorkerSessionsSendParams;
    const portal = {
      toolCallId: "call",
      action: "open",
      port: 8080,
    } satisfies P.WorkerPortalParams;
    const presence = {
      toolCallId: "call",
      action: "person",
      person: "me",
      include: ["devices"],
      limit: 10,
    } satisfies P.WorkerPresenceParams;
    const cases = [
      ["WorkerSessionsSpawnParams", spawn, { ...spawn, task: "x".repeat(8_193) }],
      ["WorkerSessionsSendParams", send, { ...send, timeoutSeconds: 86_401 }],
      ["WorkerPortalParams", portal, { ...portal, path: "relative" }],
      ["WorkerPresenceParams", presence, { ...presence, limit: 101 }],
    ] as const;
    for (const [name, valid, invalid] of cases) {
      const validate = P[`validate${name}`];
      expect(validate.schema).toBe(P[`${name}Schema`]);
      expect(validate(valid)).toBe(true);
      expect(validate({ ...valid, extra: true })).toBe(false);
      expect(validate(invalid)).toBe(false);
      expect(validate.errors?.length).toBeGreaterThan(0);
    }
    expect(P.validateWorkerSessionsSpawnParams({ ...spawn, agentId: " agent " })).toBe(false);
    expect(Value.Check(Schema.PlacedSessionsSpawnSchema, { task: "run", agentId: " agent " })).toBe(
      true,
    );
    const result = { resultJson: "{}" } satisfies P.WorkerSessionToolResult;
    const response = {
      type: "res",
      id: "reply",
      ok: true,
      payload: result,
    } satisfies P.WorkerSessionsSpawnResponseFrame;
    const errorResponse = {
      type: "res",
      id: "error",
      ok: false,
      error: { code: "INVALID_REQUEST", message: "invalid", details: { reason: "invalid-frame" } },
    };
    expectTypeOf<P.WorkerSessionsSendResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
    expectTypeOf<P.WorkerPortalResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
    expectTypeOf<P.WorkerPresenceResponseFrame>().toEqualTypeOf<P.WorkerSessionsSpawnResponseFrame>();
    for (const name of [
      "WorkerSessionsSpawnParamsSchema",
      "WorkerSessionsSendParamsSchema",
      "WorkerPortalParamsSchema",
      "WorkerPresenceParamsSchema",
      "WorkerSessionToolResultSchema",
      "WorkerSessionsSpawnResponseFrameSchema",
      "WorkerSessionsSendResponseFrameSchema",
      "WorkerPortalResponseFrameSchema",
      "WorkerPresenceResponseFrameSchema",
    ] as const) {
      expect(P[name]).toBe(Schema[name]);
      expect(ProtocolSchemas).not.toHaveProperty(name.replace(/Schema$/, ""));
    }
    for (const schema of [
      P.WorkerSessionsSpawnResponseFrameSchema,
      P.WorkerSessionsSendResponseFrameSchema,
      P.WorkerPortalResponseFrameSchema,
      P.WorkerPresenceResponseFrameSchema,
    ]) {
      expect(schema).toBe(Schema.WorkerSessionToolResponseFrameSchema);
      expect(Value.Check(schema, response)).toBe(true);
      expect(Value.Check(schema, { ...response, payload: { content: [] } })).toBe(false);
      expect(Value.Check(schema, errorResponse)).toBe(true);
    }
    expect(P.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH).toBe(8_192);
    expect(Schema.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH).toBe(8_192);
    for (const [name, value] of [
      ["WORKER_SESSION_TOOLS_PROTOCOL_FEATURE", "worker-session-tools-v1"],
      ["WORKER_PORTAL_PROTOCOL_FEATURE", "worker-portal-v1"],
      ["WORKER_PRESENCE_PROTOCOL_FEATURE", "worker-presence-v1"],
    ] as const) {
      expect(P[name]).toBe(value);
      expect(Schema[name]).toBe(value);
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
    expectTypeOf<P.WorkerSessionsSpawnParams>().toEqualTypeOf<Schema.WorkerSessionsSpawnParams>();
    expectTypeOf<P.WorkerSessionsSendParams>().toEqualTypeOf<Schema.WorkerSessionsSendParams>();
    expectTypeOf<P.WorkerPortalParams>().toEqualTypeOf<Schema.WorkerPortalParams>();
    expectTypeOf<P.WorkerPresenceParams>().toEqualTypeOf<Schema.WorkerPresenceParams>();
    expectTypeOf<P.WorkerSessionToolResult>().toEqualTypeOf<Schema.WorkerSessionToolResult>();
  });
});

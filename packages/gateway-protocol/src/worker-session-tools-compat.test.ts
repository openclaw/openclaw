import { Value } from "typebox/value";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as protocol from "./index.js";
import * as Schema from "./schema.js";
import { ProtocolSchemas } from "./schema/protocol-schemas.js";

describe("released worker tool imports", () => {
  it("preserves published worker tool imports without advertising retired RPCs", () => {
    const spawn = {
      toolCallId: " call ",
      task: "run",
    } satisfies protocol.WorkerSessionsSpawnParams;
    const send = {
      toolCallId: "call",
      sessionKey: "agent:main:child",
      message: "continue",
    } satisfies protocol.WorkerSessionsSendParams;
    const portal = {
      toolCallId: "call",
      action: "open",
      port: 8080,
    } satisfies protocol.WorkerPortalParams;
    const presence = {
      toolCallId: "call",
      action: "person",
      person: "me",
      include: ["devices"],
      limit: 10,
    } satisfies protocol.WorkerPresenceParams;
    const cases = [
      [
        protocol.validateWorkerSessionsSpawnParams,
        protocol.WorkerSessionsSpawnParamsSchema,
        spawn,
        { ...spawn, task: "x".repeat(8_193) },
      ],
      [
        protocol.validateWorkerSessionsSendParams,
        protocol.WorkerSessionsSendParamsSchema,
        send,
        { ...send, timeoutSeconds: 86_401 },
      ],
      [
        protocol.validateWorkerPortalParams,
        protocol.WorkerPortalParamsSchema,
        portal,
        { ...portal, path: "relative" },
      ],
      [
        protocol.validateWorkerPresenceParams,
        protocol.WorkerPresenceParamsSchema,
        presence,
        { ...presence, limit: 101 },
      ],
    ] as const;
    for (const [validate, schema, valid, invalid] of cases) {
      expect(validate.schema).toBe(schema);
      expect(validate(valid)).toBe(true);
      expect(validate({ ...valid, extra: true })).toBe(false);
      expect(validate(invalid)).toBe(false);
      expect(validate.errors?.length).toBeGreaterThan(0);
    }
    expect(protocol.validateWorkerSessionsSpawnParams({ ...spawn, agentId: " agent " })).toBe(
      false,
    );
    expect(Value.Check(Schema.PlacedSessionsSpawnSchema, { task: "run", agentId: " agent " })).toBe(
      true,
    );
    const result = { resultJson: "{}" } satisfies protocol.WorkerSessionToolResult;
    const response = {
      type: "res",
      id: "reply",
      ok: true,
      payload: result,
    } satisfies protocol.WorkerSessionsSpawnResponseFrame;
    expectTypeOf<protocol.WorkerSessionsSendResponseFrame>().toEqualTypeOf<protocol.WorkerSessionsSpawnResponseFrame>();
    expectTypeOf<protocol.WorkerPortalResponseFrame>().toEqualTypeOf<protocol.WorkerSessionsSpawnResponseFrame>();
    expectTypeOf<protocol.WorkerPresenceResponseFrame>().toEqualTypeOf<protocol.WorkerSessionsSpawnResponseFrame>();
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
      expect(protocol[name]).toBe(Schema[name]);
      expect(ProtocolSchemas).not.toHaveProperty(name.replace(/Schema$/, ""));
    }
    for (const schema of [
      protocol.WorkerSessionsSpawnResponseFrameSchema,
      protocol.WorkerSessionsSendResponseFrameSchema,
      protocol.WorkerPortalResponseFrameSchema,
      protocol.WorkerPresenceResponseFrameSchema,
    ]) {
      expect(schema).toBe(Schema.WorkerSessionToolResponseFrameSchema);
      expect(Value.Check(schema, response)).toBe(true);
      expect(Value.Check(schema, { ...response, payload: { content: [] } })).toBe(false);
      expect(
        Value.Check(schema, {
          type: "res",
          id: "error",
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: "invalid",
            details: { reason: "invalid-frame" },
          },
        }),
      ).toBe(true);
    }
    expect(protocol.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH).toBe(8_192);
    expect(Schema.WORKER_SESSION_TOOL_MAX_TEXT_LENGTH).toBe(8_192);
    for (const [name, value] of [
      ["WORKER_SESSION_TOOLS_PROTOCOL_FEATURE", "worker-session-tools-v1"],
      ["WORKER_PORTAL_PROTOCOL_FEATURE", "worker-portal-v1"],
      ["WORKER_PRESENCE_PROTOCOL_FEATURE", "worker-presence-v1"],
    ] as const) {
      expect(protocol[name]).toBe(value);
      expect(Schema[name]).toBe(value);
      expect(protocol.WORKER_PROTOCOL_FEATURES).not.toContain(value);
    }
    for (const method of [
      "worker.sessions.spawn",
      "worker.sessions.send",
      "worker.portal",
      "worker.presence",
    ]) {
      expect(protocol.WORKER_PROTOCOL_METHODS).not.toContain(method);
    }
    expectTypeOf<protocol.WorkerSessionsSpawnParams>().toEqualTypeOf<Schema.WorkerSessionsSpawnParams>();
    expectTypeOf<protocol.WorkerSessionsSendParams>().toEqualTypeOf<Schema.WorkerSessionsSendParams>();
    expectTypeOf<protocol.WorkerPortalParams>().toEqualTypeOf<Schema.WorkerPortalParams>();
    expectTypeOf<protocol.WorkerPresenceParams>().toEqualTypeOf<Schema.WorkerPresenceParams>();
    expectTypeOf<protocol.WorkerSessionToolResult>().toEqualTypeOf<Schema.WorkerSessionToolResult>();
  });
});

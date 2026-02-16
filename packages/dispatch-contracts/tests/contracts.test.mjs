import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTraceContextHeaders,
  extractTraceContextFromHeaders,
  parseTraceParent,
  validateDispatchCommand,
} from "../src/index.mjs";

test("parseTraceParent accepts W3C traceparent and exposes trace id", () => {
  const parsed = parseTraceParent("00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01");
  assert.equal(parsed?.version, "00");
  assert.equal(parsed?.traceId, "4bf92f3577b34da6a3ce929d0e0e4736a");
  assert.equal(parsed?.parentId, "00f067aa0ba902b7");
});

test("extractTraceContextFromHeaders maps traceparent in preference to legacy x-trace-id", () => {
  const context = extractTraceContextFromHeaders({
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01",
    "x-trace-id": "legacy-trace",
  });
  assert.equal(context.source, "traceparent");
  assert.equal(context.traceId, "4bf92f3577b34da6a3ce929d0e0e4736a");
});

test("buildTraceContextHeaders produces legacy x-trace-id for backward compatibility", () => {
  const result = buildTraceContextHeaders({ traceId: "legacy-123" });
  assert.equal(result.headers["x-trace-id"], "legacy-123");
  assert.equal(result.emittedTraceId, "legacy-123");
  assert.equal(result.source, "legacy");
});

test("validateDispatchCommand enforces required envelope fields", () => {
  const invalid = validateDispatchCommand({
    tenantId: "tenant-1",
    toolName: "ticket.create",
    actor: {
      id: "dispatcher-1",
      role: "dispatcher",
      type: "AGENT",
    },
    requestId: "req-1",
    correlationId: "corr-1",
    payload: { hello: "world" },
  });
  assert.equal(invalid.ok, true);

  const invalidResult = validateDispatchCommand({
    tenantId: "tenant-1",
    toolName: "ticket.create",
  });
  assert.equal(invalidResult.ok, false);
  assert.ok(invalidResult.errors.length >= 1);
});

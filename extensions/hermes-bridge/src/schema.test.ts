import { describe, expect, it } from "vitest";
import { normalizeHermesBridgeRequest } from "./schema.js";

describe("normalizeHermesBridgeRequest", () => {
  it("normalizes Hermes delegation requests with safe defaults", () => {
    expect(
      normalizeHermesBridgeRequest({
        requestId: "req-1",
        taskId: "status.echo",
        requestedBy: "not-trusted",
        priority: "high",
        allowedTools: ["telegram.send", "telegram.send", "", 1],
        input: { message: "hello" },
      }),
    ).toEqual({
      ok: true,
      request: {
        requestId: "req-1",
        idempotencyKey: "req-1",
        taskId: "status.echo",
        requestedBy: "hermes",
        intent: "status.echo",
        priority: "high",
        requiresConfirmation: false,
        allowedTools: ["telegram.send"],
        input: { message: "hello" },
        dryRun: true,
      },
    });
  });

  it("fails closed without taskId", () => {
    expect(normalizeHermesBridgeRequest({ input: {} })).toMatchObject({
      ok: false,
      error: { type: "invalid_request" },
    });
  });
});

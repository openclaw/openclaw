import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  GatewaySuspendBlockerSchema,
  validateGatewaySuspendPrepareResult,
  validateGatewaySuspendStatusResult,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendHandoffParams,
} from "./index.js";

describe("gateway suspension protocol", () => {
  it("requires an exact handoff target and rejects unrelated interruption policy", () => {
    const target = { pid: 1, processInstanceId: "gateway-process" };
    const params = { suspensionId: "held-lease", target };
    expect(validateGatewaySuspendHandoffParams(params)).toBe(true);
    for (const rejected of [
      { ...params, target: undefined },
      { ...params, force: true },
      { ...params, waitMs: 0 },
      { ...params, target: { ...target, processInstanceId: " " } },
      { ...params, target: { ...target, pid: 0 } },
      { ...params, target: { ...target, port: 18789 } },
      { ...params, target: { ...target, successor: "other" } },
    ]) {
      expect(validateGatewaySuspendHandoffParams(rejected)).toBe(false);
    }
  });
  it("keeps prepare params closed and bounded", () => {
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request" })).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "preserve",
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "terminate",
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareParams({
        requestId: "host-request",
        terminalPolicy: "preserve",
        drain: true,
      }),
    ).toBe(true);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", drain: false })).toBe(
      true,
    );
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", drain: "true" })).toBe(
      false,
    );
    expect(validateGatewaySuspendPrepareParams({ requestId: "   " })).toBe(false);
    expect(
      validateGatewaySuspendPrepareParams({ requestId: "host-request", terminalPolicy: "close" }),
    ).toBe(false);
    expect(validateGatewaySuspendPrepareParams({ requestId: "host-request", extra: true })).toBe(
      false,
    );
  });

  it("keeps the historical terminal-session blocker wire-compatible", () => {
    expect(
      Value.Check(GatewaySuspendBlockerSchema, {
        kind: "terminal-session",
        count: 1,
        message: "1 open terminal session(s)",
      }),
    ).toBe(true);
  });

  it("accepts closed draining prepare results without changing existing result variants", () => {
    const draining = {
      status: "draining",
      suspensionId: "suspension-1",
      expiresAtMs: 2_000,
      retryAfterMs: 250,
      activeCount: 1,
      blockers: [{ kind: "terminal-session", count: 1, message: "1 open terminal session" }],
    };

    expect(validateGatewaySuspendPrepareResult(draining)).toBe(true);
    expect(validateGatewaySuspendPrepareResult({ ...draining, unexpected: true })).toBe(false);
    expect(
      validateGatewaySuspendPrepareResult({
        status: "busy",
        reason: "active-work",
        retryAfterMs: 250,
        activeCount: 1,
        blockers: draining.blockers,
      }),
    ).toBe(true);
    expect(
      validateGatewaySuspendPrepareResult({
        status: "ready",
        suspensionId: "suspension-1",
        expiresAtMs: 2_000,
        activeCount: 0,
        blockers: [],
      }),
    ).toBe(true);
  });

  it("accepts closed draining status results without changing existing status variants", () => {
    const draining = {
      status: "draining",
      expiresAtMs: 2_000,
      retryAfterMs: 250,
      activeCount: 1,
      blockers: [{ kind: "terminal-persistence", count: 1, message: "1 pending terminal write" }],
    };

    expect(validateGatewaySuspendStatusResult(draining)).toBe(true);
    expect(validateGatewaySuspendStatusResult({ ...draining, suspensionId: "id" })).toBe(false);
    expect(validateGatewaySuspendStatusResult({ status: "running" })).toBe(true);
    expect(validateGatewaySuspendStatusResult({ status: "ready", expiresAtMs: 2_000 })).toBe(true);
  });

  it.each([
    {
      name: "prepare busy",
      validate: validateGatewaySuspendPrepareResult,
      result: {
        status: "busy",
        reason: "active-work",
        retryAfterMs: 250,
        activeCount: 1,
        blockers: [{ kind: "session-mutation", count: 1, message: "1 pending write" }],
      },
    },
    {
      name: "prepare draining",
      validate: validateGatewaySuspendPrepareResult,
      result: {
        status: "draining",
        suspensionId: "held-lease",
        expiresAtMs: 2_000,
        retryAfterMs: 250,
        activeCount: 1,
        blockers: [{ kind: "session-mutation", count: 1, message: "1 pending write" }],
      },
    },
    {
      name: "prepare ready",
      validate: validateGatewaySuspendPrepareResult,
      result: {
        status: "ready",
        suspensionId: "held-lease",
        expiresAtMs: 2_000,
        activeCount: 0,
        blockers: [],
      },
    },
    {
      name: "status draining",
      validate: validateGatewaySuspendStatusResult,
      result: {
        status: "draining",
        expiresAtMs: 2_000,
        retryAfterMs: 250,
        activeCount: 1,
        blockers: [{ kind: "session-mutation", count: 1, message: "1 pending write" }],
      },
    },
    {
      name: "status ready",
      validate: validateGatewaySuspendStatusResult,
      result: { status: "ready", expiresAtMs: 2_000 },
    },
  ])("validates $name custody without erasing unknown or held evidence", ({ validate, result }) => {
    expect(validate(result)).toBe(true);
    expect(result).not.toHaveProperty("writeCustody");
    for (const writeCustody of [
      [],
      [{ phase: "backup", count: 0 }],
      [{ phase: "migration", count: 1 }],
      [{ phase: "future-owner-phase", count: 2 }],
    ]) {
      const response = { ...result, writeCustody };
      const original = structuredClone(response);
      expect(validate(response)).toBe(true);
      expect(response).toEqual(original);
    }
    for (const writeCustody of [
      null,
      {},
      [null],
      [{ count: 1 }],
      [{ phase: "", count: 1 }],
      [{ phase: "backup", count: -1 }],
      [{ phase: "backup", count: 0.5 }],
      [{ phase: "backup", count: "1" }],
      [{ phase: "backup", count: 1, extra: true }],
    ]) {
      expect(validate({ ...result, writeCustody })).toBe(false);
      expect(validate.errors).not.toBeNull();
    }
  });
});

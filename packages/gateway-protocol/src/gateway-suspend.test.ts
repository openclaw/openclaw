import { describe, expect, it } from "vitest";
import {
  validateGatewaySuspendStatusParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendPrepareResult,
  validateGatewaySuspendStatusResult,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendHandoffParams,
  GatewaySuspendHandoffResultSchema as HandoffResult,
} from "./index.js";
import { schemaValidation, validation } from "./schema/protocol-validation.test-support.js";

const drainingResult = (kind: string) => ({
  status: "draining",
  expiresAtMs: 2_000,
  retryAfterMs: 250,
  activeCount: 1,
  blockers: [{ kind, count: 1, message: "1 blocker" }],
});

describe("gateway suspension protocol", () => {
  it("opts into status metadata without extending resume parameters", () => {
    const params = { suspensionId: "held-lease", includeLifecycle: true };
    expect(validateGatewaySuspendStatusParams(params)).toBe(true);
    expect(validateGatewaySuspendStatusParams({ ...params, includeLifecycle: "true" })).toBe(false);
    expect(validateGatewaySuspendResumeParams(params)).toBe(false);
    expect(validateGatewaySuspendResumeParams({ suspensionId: "held-lease" })).toBe(true);
  });
  it("requires an exact handoff target and rejects unrelated interruption policy", () => {
    const target = { pid: 1, processInstanceId: "gateway-process" };
    const params = { suspensionId: "held-lease", target };
    const handoff = validation(validateGatewaySuspendHandoffParams);
    handoff.accepts(params, { ...params, commit: true });
    handoff.rejects(
      { ...params, target: undefined },
      { ...params, force: true },
      { ...params, waitMs: 0 },
      { ...params, commit: false },
      { ...params, target: { ...target, processInstanceId: " " } },
      { ...params, target: { ...target, pid: 0 } },
      { ...params, target: { ...target, port: 18789 } },
    );
    const receipt = { suspensionId: "held-lease", expiresAtMs: 2_000 };
    schemaValidation(HandoffResult).accepts(
      { ...receipt, status: "armed" },
      { ...receipt, status: "committed" },
    );
    schemaValidation(HandoffResult).rejects({ ...receipt, status: "scheduled" });
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

  it("accepts legacy terminal blockers in closed draining and busy prepare results", () => {
    const draining = {
      ...drainingResult("terminal-session"),
      suspensionId: "suspension-1",
    };

    const { suspensionId: _id, expiresAtMs: _expiry, ...busy } = draining;
    validation(validateGatewaySuspendPrepareResult).accepts(draining, {
      ...busy,
      status: "busy",
      reason: "active-work",
    });
    validation(validateGatewaySuspendPrepareResult).rejects({ ...draining, unexpected: true });
  });

  it("accepts running status and closed draining status results", () => {
    const draining = drainingResult("terminal-persistence");

    validation(validateGatewaySuspendStatusResult).accepts(draining, { status: "running" });
    validation(validateGatewaySuspendStatusResult).rejects({ ...draining, suspensionId: "id" });
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

import { describe, expect, it } from "vitest";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";

function expectExecTarget(
  actual: ReturnType<typeof resolveExecTarget>,
  expected: {
    configuredTarget: string;
    requestedTarget: string | null;
    selectedTarget: string;
    effectiveHost: string;
  },
) {
  expect(actual.configuredTarget).toBe(expected.configuredTarget);
  expect(actual.requestedTarget).toBe(expected.requestedTarget);
  expect(actual.selectedTarget).toBe(expected.selectedTarget);
  expect(actual.effectiveHost).toBe(expected.effectiveHost);
}

describe("resolveExecTarget", () => {
  it("authenticates only the exact deliberate rejection once, not copies or invalid target syntax", () => {
    let denied: unknown;
    try {
      resolveExecTarget({
        configuredTarget: "gateway",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: false,
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(Error);
    const error = denied as Error;
    const serialized = JSON.stringify(error);
    for (const copy of [
      new Error(error.message),
      Object.assign(new Error(error.message), error),
      structuredClone(error),
      JSON.parse(serialized),
    ]) {
      expect(consumeTrustedToolNoStartError(copy)).toBe(false);
    }
    expect(Object.keys(error)).toEqual([]);
    expect(consumeTrustedToolNoStartError(error)).toBe(true);
    expect(consumeTrustedToolNoStartError(error)).toBe(false);
    let invalidError: unknown;
    try {
      requireValidExecTarget("invalid-host");
    } catch (invalid) {
      invalidError = invalid;
    }
    expect(invalidError).toBeInstanceOf(Error);
    expect(consumeTrustedToolNoStartError(invalidError)).toBe(false);
  });

  it.each([
    ["auto", undefined, true, false, "auto", "sandbox"],
    ["auto", undefined, false, false, "auto", "gateway"],
    ["auto", "node", false, false, "node", "node"],
    ["auto", "gateway", false, false, "gateway", "gateway"],
    ["auto", "sandbox", true, false, "sandbox", "sandbox"],
    ["node", "node", true, false, "node", "node"],
    ["auto", "sandbox", true, true, "gateway", "gateway"],
    ["auto", "node", false, true, "node", "node"],
    ["node", "node", false, true, "node", "node"],
    ["node", undefined, false, true, "node", "node"],
  ] as const)(
    "resolves configured=%s requested=%s sandbox=%s elevated=%s to selected=%s host=%s",
    (
      configuredTarget,
      requestedTarget,
      sandboxAvailable,
      elevatedRequested,
      selectedTarget,
      effectiveHost,
    ) => {
      expectExecTarget(
        resolveExecTarget({
          configuredTarget,
          requestedTarget,
          elevatedRequested,
          sandboxAvailable,
        }),
        {
          configuredTarget,
          requestedTarget: requestedTarget ?? null,
          selectedTarget,
          effectiveHost,
        },
      );
    },
  );

  it.each(["gateway", "node"] as const)(
    "rejects per-call host=%s override from auto when sandbox is available",
    (requestedTarget) => {
      expect(() =>
        resolveExecTarget({
          configuredTarget: "auto",
          requestedTarget,
          elevatedRequested: false,
          sandboxAvailable: true,
        }),
      ).toThrow(
        `exec host not allowed (requested ${requestedTarget}; configured host is auto; set tools.exec.host=${requestedTarget} to allow this override).`,
      );
    },
  );

  it.each([false, true])(
    "rejects gateway override when configured host is node (elevated=%s)",
    (elevatedRequested) => {
      expect(() =>
        resolveExecTarget({
          configuredTarget: "node",
          requestedTarget: "gateway",
          elevatedRequested,
          sandboxAvailable: false,
        }),
      ).toThrow(
        "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
      );
    },
  );

  it.each([
    ["auto", true, false, "sandbox"],
    ["auto", false, false, "gateway"],
    ["sandbox", true, false, "sandbox"],
    ["gateway", true, false, "gateway"],
    ["gateway", false, false, "gateway"],
    ["node", false, false, "node"],
    ["sandbox", true, true, "gateway"],
    ["node", true, true, "node"],
  ] as const)(
    "inherits configured host=%s for auto (sandbox=%s, elevated=%s)",
    (configuredTarget, sandboxAvailable, elevatedRequested, effectiveHost) => {
      const result = resolveExecTarget({
        configuredTarget,
        requestedTarget: "auto",
        elevatedRequested,
        sandboxAvailable,
      });
      expect(result).toEqual(
        resolveExecTarget({ configuredTarget, elevatedRequested, sandboxAvailable }),
      );
      expect(result.effectiveHost).toBe(effectiveHost);
    },
  );

  describe("required session sandbox", () => {
    it.each(["gateway", "node"] as const)(
      "rejects explicit host=%s even when the configured host matches",
      (host) => {
        expect(() =>
          resolveExecTarget({
            configuredTarget: host,
            requestedTarget: host,
            elevatedRequested: false,
            sandboxAvailable: true,
            sandboxRequired: true,
          }),
        ).toThrow(/sandbox|required|not allowed/i);
      },
    );

    it.each([
      { host: "gateway", requestedTarget: undefined },
      { host: "gateway", requestedTarget: "auto" },
      { host: "node", requestedTarget: undefined },
      { host: "node", requestedTarget: "auto" },
    ] as const)(
      "keeps requested=$requestedTarget sandboxed despite configured host=$host",
      ({ host, requestedTarget }) => {
        expect(
          resolveExecTarget({
            configuredTarget: host,
            requestedTarget,
            elevatedRequested: false,
            sandboxAvailable: true,
            sandboxRequired: true,
          }),
        ).toMatchObject({
          configuredTarget: "auto",
          effectiveHost: "sandbox",
        });
      },
    );

    it("rejects elevated requests before they can select the gateway", () => {
      expect(() =>
        resolveExecTarget({
          configuredTarget: "auto",
          elevatedRequested: true,
          sandboxAvailable: true,
          sandboxRequired: true,
        }),
      ).toThrow(/sandbox|required|elevated/i);
    });

    it.each([undefined, "auto"] as const)(
      "fails closed with requested=%s when the required sandbox is unavailable",
      (requestedTarget) => {
        expect(() =>
          resolveExecTarget({
            configuredTarget: "auto",
            elevatedRequested: false,
            sandboxAvailable: false,
            sandboxRequired: true,
            requestedTarget,
          }),
        ).toThrow(/sandbox|required|unavailable/i);
      },
    );
  });
});

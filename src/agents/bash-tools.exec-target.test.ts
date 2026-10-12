import { describe, expect, it } from "vitest";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { resolveExecTarget } from "./bash-tools.exec-runtime.js";
import { createExecTool } from "./bash-tools.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { createLazyExecTool } from "./lazy-exec-tool.js";
import { consumeTrustedToolNoStartError } from "./tool-result-error.js";

describe("resolveExecTarget", () => {
  it("authenticates the sandbox escape rejection once, not copies or invalid syntax", () => {
    let denied: unknown;
    try {
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "gateway",
        elevatedRequested: false,
        sandboxAvailable: true,
      });
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(Error);
    if (!(denied instanceof Error)) {
      throw new Error("expected host-policy rejection");
    }
    expect(denied.message).toBe(
      "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
    );
    const serialized = JSON.stringify(denied);
    for (const copy of [
      new Error(denied.message),
      Object.assign(new Error(denied.message), denied),
      structuredClone(denied),
      JSON.parse(serialized),
    ]) {
      expect(consumeTrustedToolNoStartError(copy)).toBe(false);
    }
    expect(Object.keys(denied)).toEqual([]);
    expect(consumeTrustedToolNoStartError(denied)).toBe(true);
    expect(consumeTrustedToolNoStartError(denied)).toBe(false);
    let invalid: unknown;
    try {
      requireValidExecTarget("invalid-host");
    } catch (error) {
      invalid = error;
    }
    expect(invalid).toBeInstanceOf(Error);
    expect(consumeTrustedToolNoStartError(invalid)).toBe(false);
  });

  it.each([
    ["auto", undefined, false, false, "auto", "gateway"],
    ["auto", "node", false, true, "node", "node"],
    ["node", "node", true, false, "node", "node"],
    ["auto", "sandbox", true, true, "gateway", "gateway"],
    ["node", "auto", false, true, "node", "node"],
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
      expect(
        resolveExecTarget({
          configuredTarget,
          requestedTarget,
          elevatedRequested,
          sandboxAvailable,
        }),
      ).toEqual({
        configuredTarget,
        requestedTarget: requestedTarget === "auto" ? null : (requestedTarget ?? null),
        selectedTarget,
        effectiveHost,
      });
    },
  );

  it("rejects a node override from auto when sandbox is available", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "auto",
        requestedTarget: "node",
        elevatedRequested: false,
        sandboxAvailable: true,
      }),
    ).toThrow(
      "exec host not allowed (requested node; configured host is auto; set tools.exec.host=node to allow this override).",
    );
  });

  it("rejects gateway override from configured node even with elevation", () => {
    expect(() =>
      resolveExecTarget({
        configuredTarget: "node",
        requestedTarget: "gateway",
        elevatedRequested: true,
        sandboxAvailable: false,
      }),
    ).toThrow(
      "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    );
  });

  describe("required session sandbox", () => {
    it.each(["node"] as const)(
      "rejects explicit host=%s even when configured host matches",
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

    it("keeps per-call auto sandboxed despite configured node", () => {
      expect(
        resolveExecTarget({
          configuredTarget: "node",
          requestedTarget: "auto",
          elevatedRequested: false,
          sandboxAvailable: true,
          sandboxRequired: true,
        }),
      ).toMatchObject({ configuredTarget: "auto", effectiveHost: "sandbox" });
    });

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

    it("fails closed when the required sandbox is unavailable", () => {
      expect(() =>
        resolveExecTarget({
          configuredTarget: "auto",
          elevatedRequested: false,
          sandboxAvailable: false,
          sandboxRequired: true,
        }),
      ).toThrow(/sandbox|required|unavailable/i);
    });
  });
});

describe("removed exec timeout field", () => {
  it("rejects a stale timeout argument before command execution", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("legacy-timeout", {
        command: "exit 99",
        timeout: 5,
      } as never),
    ).rejects.toThrow('exec parameter "timeout" is unsupported; use "timeoutSeconds" instead');
  });
});

describe("foreground node exec wait budgets", () => {
  it.each([
    { timeoutSec: undefined, timeoutSeconds: undefined, expectedMs: 1_810_000 },
    { timeoutSec: 120, timeoutSeconds: 0, expectedMs: 130_000 },
  ])(
    "keeps prepared and pinned budgets for $timeoutSec/$timeoutSeconds seconds",
    ({ timeoutSec, timeoutSeconds, expectedMs }) => {
      for (const createTool of [createExecTool, createLazyExecTool]) {
        const tool = createTool({ host: "node", timeoutSec });
        const args = { command: "echo ready", timeoutSeconds };
        expect(tool.getExecutionTimeoutMs?.(args)).toBe(expectedMs);

        const nodeTool = pinExecToolTarget(tool, { host: "node" });
        expect(nodeTool.getExecutionTimeoutMs?.({ ...args, host: "gateway" })).toBe(expectedMs);

        const gatewayTool = pinExecToolTarget(tool, { host: "gateway" });
        expect(gatewayTool.getExecutionTimeoutMs?.({ ...args, host: "node" })).toBeUndefined();
      }
    },
  );
});

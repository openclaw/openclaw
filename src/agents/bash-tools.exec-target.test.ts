import { describe, expect, it } from "vitest";
import { requireValidExecTarget } from "../infra/exec-approvals.js";
import { assertSupportedExecParams } from "./bash-tools.exec-request-preparation.js";
import { resolveExecHost, resolveExecTarget } from "./bash-tools.exec-target.js";
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

describe("durable exec admission", () => {
  it.each([
    [{ durable: "true", background: true }, "durable must be a boolean"],
    [{ durable: true }, "requires background=true or yieldMs"],
    [{ durable: true, yieldMs: Number.NaN }, "requires background=true or yieldMs"],
    [{ durable: true, yieldMs: 100, awaitResults: true }, "cannot use awaitResults"],
    [{ durable: true, background: true, pty: true }, "does not support interactive input or PTY"],
  ] as const)("refuses unsupported request %j before launch", (args, message) => {
    expect(() => assertSupportedExecParams({ command: ":", ...args })).toThrow(message);
  });

  it.each([
    { host: "node" as const },
    { host: "gateway" as const, allowBackground: false },
    {
      sandbox: {
        containerName: "test-durable-sandbox",
        workspaceDir: "/workspace",
        containerWorkdir: "/workspace",
      },
    },
  ])("refuses unavailable durable execution on %j", async (defaults) => {
    const tool = createExecTool({ ...defaults, mode: "full" });
    await expect(
      tool.execute("durable-host", { command: ":", durable: true, background: true }),
    ).rejects.toThrow("Durable exec requires Gateway-host background execution");
  });

  it("refuses durable execution before a node-pinned surface can discard it", async () => {
    const tool = pinExecToolTarget(createExecTool({ mode: "full" }), { host: "node" });
    await expect(async () =>
      tool.execute("durable-node", { command: ":", durable: true, background: true }),
    ).rejects.toThrow("Durable exec requires Gateway-host background execution");
  });
});

describe("named node host policy", () => {
  const sandbox = {
    containerName: "test-sandbox",
    workspaceDir: "/workspace",
    containerWorkdir: "/workspace",
  };

  it.each([
    { host: "gateway" as const },
    { sandbox },
    { host: "node" as const, sandbox, sandboxRequired: true },
  ])("keeps node-only calls within configured policy %j", (defaults) => {
    expect(() => resolveExecHost({ node: "node-1" }, defaults)).toThrow(
      /exec host not allowed.*node/,
    );
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
        const defaultTool = createTool({ timeoutSec });
        expect(defaultTool.getExecutionTimeoutMs?.({ ...args, node: "node-1" })).toBe(expectedMs);

        const nodeTool = pinExecToolTarget(tool, { host: "node" });
        expect(nodeTool.getExecutionTimeoutMs?.({ ...args, host: "gateway" })).toBe(expectedMs);

        const gatewayTool = pinExecToolTarget(tool, { host: "gateway" });
        expect(gatewayTool.getExecutionTimeoutMs?.(args)).toBeUndefined();
      }
    },
  );
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { hasApprovalFreeHostExecAuthority } from "./approval-free-host-exec-authority.js";
import { jsonResult } from "./tools/common.js";

const hoisted = vi.hoisted(() => ({
  file: { version: 1, defaults: { security: "full", ask: "off" } } as ExecApprovalsFile,
  loadError: undefined as Error | undefined,
  resolvePluginTools: vi.fn(),
}));

const APPROVAL_FREE_HOST_EXEC_FALLBACK = Symbol.for(
  "openclaw.internal.approvalFreeHostExecFallback",
);

vi.mock("../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/exec-approvals.js")>()),
  loadExecApprovals: () => {
    if (hoisted.loadError) {
      throw hoisted.loadError;
    }
    return hoisted.file;
  },
}));

vi.mock("../plugins/tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/tools.js")>()),
  resolvePluginTools: (...args: unknown[]) => hoisted.resolvePluginTools(...args),
}));

function registerPolicyBrowserFixture(options: { beforeHarnessResult?: () => Promise<void> } = {}) {
  const harnessExecute = vi.fn(async () => {
    await options.beforeHarnessResult?.();
    return jsonResult({ engine: "browser-harness" });
  });
  const nativeExecute = vi.fn(async () => jsonResult({ engine: "native" }));
  hoisted.resolvePluginTools.mockImplementation(() => {
    const browser = {
      label: "Browser",
      name: "browser",
      description: "Browser Harness fixture",
      parameters: { type: "object" as const, properties: {} },
      execute: harnessExecute,
      [APPROVAL_FREE_HOST_EXEC_FALLBACK]: {
        label: "Browser",
        name: "browser",
        description: "Native browser fixture",
        parameters: { type: "object" as const, properties: {} },
        execute: nativeExecute,
      },
    };
    setPluginToolMeta(browser, { pluginId: "browser", optional: false });
    return [browser];
  });
  return { harnessExecute, nativeExecute };
}

describe("hasApprovalFreeHostExecAuthority", () => {
  afterEach(() => {
    hoisted.file = { version: 1, defaults: { security: "full", ask: "off" } };
    hoisted.loadError = undefined;
    hoisted.resolvePluginTools.mockReset();
  });

  it.each([
    { mode: "full", security: "full", ask: "off", expected: true },
    { mode: "allowlist", security: "allowlist", ask: "off", expected: false },
    { mode: "ask", security: "allowlist", ask: "on-miss", expected: false },
  ] as const)("returns $expected for $mode/$security/$ask", ({ expected, ...config }) => {
    expect(
      hasApprovalFreeHostExecAuthority({
        ...config,
        bypassHostApprovalFloors: true,
      }),
    ).toBe(expected);
  });

  it("requires the live host approvals floor to remain full/off", () => {
    hoisted.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
    };

    expect(
      hasApprovalFreeHostExecAuthority({
        mode: "full",
        security: "full",
        ask: "off",
      }),
    ).toBe(false);
  });

  it("fails closed when the host approvals floor cannot be read", () => {
    hoisted.loadError = new Error("approval store unavailable");

    expect(
      hasApprovalFreeHostExecAuthority({
        mode: "full",
        security: "full",
        ask: "off",
      }),
    ).toBe(false);
  });

  it("selects a host-exec tool only when final policy retains unrestricted exec", async () => {
    const { harnessExecute, nativeExecute } = registerPolicyBrowserFixture();
    const tools = createOpenClawCodingTools({
      workspaceDir: process.cwd(),
      exec: { mode: "full", security: "full", ask: "off" },
      config: { tools: { allow: ["exec", "browser"] } },
    });
    const browser = tools.find((tool) => tool.name === "browser");

    await expect(browser?.execute("browser-full", {})).resolves.toMatchObject({
      details: { engine: "browser-harness" },
    });
    expect(harnessExecute).toHaveBeenCalledOnce();
    expect(nativeExecute).not.toHaveBeenCalled();
  });

  it("uses the fallback when exec is guarded or removed by final policy", async () => {
    for (const options of [
      {
        exec: { mode: "ask" as const, security: "allowlist" as const, ask: "on-miss" as const },
        config: { tools: { allow: ["exec", "browser"] } },
      },
      {
        exec: { mode: "full" as const, security: "full" as const, ask: "off" as const },
        config: { tools: { deny: ["exec"] } },
      },
    ]) {
      const { harnessExecute, nativeExecute } = registerPolicyBrowserFixture();
      const tools = createOpenClawCodingTools({ workspaceDir: process.cwd(), ...options });
      const browser = tools.find((tool) => tool.name === "browser");

      await expect(browser?.execute("browser-native", {})).resolves.toMatchObject({
        details: { engine: "native" },
      });
      expect(nativeExecute).toHaveBeenCalledOnce();
      expect(harnessExecute).not.toHaveBeenCalled();
    }
  });

  it("revalidates unrestricted exec authority before delegating", async () => {
    const { harnessExecute } = registerPolicyBrowserFixture();
    const tools = createOpenClawCodingTools({
      workspaceDir: process.cwd(),
      exec: { mode: "full", security: "full", ask: "off" },
      config: { tools: { allow: ["exec", "browser"] } },
    });
    const browser = tools.find((tool) => tool.name === "browser");

    hoisted.loadError = new Error("approval store unavailable");
    await expect(browser?.execute("browser-revoked", {})).rejects.toThrow(
      "approval-free host exec authority was revoked",
    );
    expect(harnessExecute).not.toHaveBeenCalled();
  });

  it("revalidates unrestricted exec authority after async preparation at process launch", async () => {
    let markPrepared: (() => void) | undefined;
    const prepared = new Promise<void>((resolve) => {
      markPrepared = resolve;
    });
    let releasePreparation: (() => void) | undefined;
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const { harnessExecute } = registerPolicyBrowserFixture({
      beforeHarnessResult: async () => {
        markPrepared?.();
        await preparationReleased;
        await runCommandWithTimeout([process.execPath, "-e", "process.exit(0)"], 5_000);
      },
    });
    const tools = createOpenClawCodingTools({
      workspaceDir: process.cwd(),
      exec: { mode: "full", security: "full", ask: "off" },
      config: { tools: { allow: ["exec", "browser"] } },
    });
    const browser = tools.find((tool) => tool.name === "browser");

    const executing = browser?.execute("browser-revoked-during-preparation", {});
    await prepared;
    hoisted.file = {
      version: 1,
      defaults: { security: "allowlist", ask: "on-miss" },
    };
    releasePreparation?.();

    await expect(executing).rejects.toThrow(
      "tool denied: approval-free host exec authority was revoked",
    );
    expect(harnessExecute).toHaveBeenCalledOnce();
  });
});

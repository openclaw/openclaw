import { describe, expect, it, vi } from "vitest";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  buildCodexRuntimeThreadConfigForRun,
  type CodexThreadConfigurationContext,
  readCodexManagedRequirementsFingerprint,
} from "./thread-requests.js";

const managedRequirements = {
  hooks: {
    PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "managed-hook" }] }],
  },
  featureRequirements: { hooks: true },
};

describe("configured app-server managed requirements", () => {
  it("admits managed hooks for an interactive plugin-policy turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
  });

  it("admits the exact managed requirements captured for a scheduled restricted turn", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const managedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request,
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint: managedRequirementsFingerprint,
      }),
    ).resolves.toEqual({ enableManagedHooks: true });
  });

  it("fails closed when managed requirements change after scheduled authorization", async () => {
    const request = vi.fn(async () => ({ requirements: managedRequirements }));
    const allowedManagedRequirementsFingerprint = await readCodexManagedRequirementsFingerprint({
      request: vi.fn(async () => ({ requirements: { hooks: {} } })),
    } as never);

    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowedManagedRequirementsFingerprint,
      }),
    ).rejects.toThrow("managed requirements changed");
  });

  it("keeps an explicit managed disable above the attested hook inventory", async () => {
    const request = vi.fn(async () => ({
      requirements: { ...managedRequirements, featureRequirements: { hooks: false } },
    }));
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        allowConfiguredManagedHooks: true,
        privateManagedHooksPresent: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: false });
  });
});

describe("admitted native goal tool policy", () => {
  it.each([false, true])(
    "only enables goals under a restricted policy with custody=%s",
    (custody) => {
      const config = buildCodexRuntimeThreadConfigForRun(
        {
          modelId: "gpt-5.5",
          pluginHarnessToolPolicyRestricted: true,
          ...(custody ? { nativeGoal: { objective: "Finish authorized work" } } : {}),
        } as CodexThreadConfigurationContext,
        { mcp_servers: { inherited: { command: "must-stay-disabled" } } },
        { nativeCodeModeEnabled: false, hostSystemAgentActive: false },
      );
      expect(config).toMatchObject({
        "features.goals": custody,
        "features.shell_tool": false,
        "features.code_mode": false,
        "features.unified_exec": false,
        "features.apps": false,
        "features.plugins": false,
        "features.multi_agent": false,
        "features.multi_agent_v2": false,
        "orchestrator.mcp.enabled": false,
        mcp_servers: { inherited: { command: "must-stay-disabled", enabled: false } },
      });
    },
  );

  it("allows a managed goal requirement only under native custody", async () => {
    const request = vi.fn(async () => ({ requirements: { featureRequirements: { goals: true } } }));
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
      }),
    ).rejects.toThrow("cannot override required feature goals");
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: true,
        nativeGoalsEnabled: true,
      }),
    ).resolves.toEqual({ enableManagedHooks: false });
  });

  it("does not silently run a native goal when managed policy disables the feature", async () => {
    const request = vi.fn(async () => ({
      requirements: { featureRequirements: { goals: false } },
    }));
    await expect(
      assertCodexManagedRequirementsDoNotOverrideToolPolicy({ request } as never, {
        restrictedToolSurface: false,
        nativeGoalsEnabled: true,
      }),
    ).rejects.toThrow("native goals are disabled by managed requirements");
  });
});

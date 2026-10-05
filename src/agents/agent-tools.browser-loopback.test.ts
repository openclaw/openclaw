import { describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import * as openClawPluginTools from "./openclaw-plugin-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { createAgentToolsSandboxContext } from "./test-helpers/agent-tools-sandbox-context.js";
import { createHostSandboxFsBridge } from "./test-helpers/host-sandbox-fs-bridge.js";

describe("assembled browser loopback authority", () => {
  const browserLoopbackCases: {
    name: string;
    options?: NonNullable<Parameters<typeof createOpenClawCodingTools>[0]>;
    approvals?: execApprovals.ExecApprovalsFile;
    allowed: boolean;
  }[] = [
    { name: "unrestricted local execution", allowed: true },
    {
      name: "explicit full session over host approval floors",
      options: { sessionPermissionPolicy: { root: "/workspace", mode: "full" } },
      approvals: { version: 1, defaults: { security: "deny", ask: "always" }, agents: {} },
      allowed: true,
    },
    {
      name: "sandbox with host browser control",
      options: {
        sandbox: createAgentToolsSandboxContext({
          workspaceDir: "/workspace",
          fsBridge: createHostSandboxFsBridge("/workspace"),
          browserAllowHostControl: true,
        }),
      },
      allowed: false,
    },
    {
      name: "workspace session",
      options: { sessionPermissionPolicy: { root: "/workspace", mode: "workspace" } },
      allowed: false,
    },
    {
      name: "workspace-only filesystem",
      options: { requireWorkspaceOnly: true },
      allowed: false,
    },
    {
      name: "node execution",
      options: { exec: { host: "node" } },
      allowed: false,
    },
    {
      name: "exec allowlist",
      options: { exec: { security: "allowlist" } },
      allowed: false,
    },
    {
      name: "full session tightened by exec override",
      options: {
        sessionPermissionPolicy: { root: "/workspace", mode: "full" },
        exec: { security: "allowlist" },
      },
      allowed: false,
    },
    {
      name: "host approval floor",
      approvals: { version: 1, defaults: { security: "allowlist" }, agents: {} },
      allowed: false,
    },
    {
      name: "exec approval requirement",
      options: { exec: { security: "full", ask: "always" } },
      allowed: false,
    },
    {
      name: "scheduled approval requirement",
      options: {
        sessionPermissionPolicy: { root: "/workspace", mode: "full" },
        scheduledToolPolicy: {
          version: 1,
          mode: "trusted",
          execTarget: { host: "gateway", ask: "always" },
        },
      },
      allowed: false,
    },
    {
      name: "denied exec tool",
      options: { config: { tools: { deny: ["exec"] } } },
      allowed: false,
    },
    {
      name: "inherited runtime tool ceiling",
      options: { runtimeToolAllowlist: ["browser"], inheritRuntimeToolAllowlist: true },
      allowed: false,
    },
  ];

  it.each(browserLoopbackCases)(
    "prepares browser loopback capability for $name on both assembly paths",
    ({ options, approvals, allowed }) => {
      const loadApprovals = vi
        .spyOn(execApprovals, "loadExecApprovals")
        .mockReturnValue(
          approvals ?? { version: 1, defaults: { security: "full", ask: "off" }, agents: {} },
        );
      const plugins = vi
        .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
        .mockReturnValue([]);
      try {
        for (const pluginOnly of [false, true]) {
          vi.mocked(createOpenClawTools).mockClear();
          plugins.mockClear();
          createOpenClawCodingTools({
            ...options,
            ...(pluginOnly
              ? {
                  toolConstructionPlan: {
                    includeBaseCodingTools: false,
                    includeShellTools: false,
                    includeChannelTools: false,
                    includeOpenClawTools: false,
                    includePluginTools: true,
                  },
                }
              : {}),
          });
          const preparedOptions = pluginOnly
            ? plugins.mock.calls.at(-1)?.[0].options
            : vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0];
          const { context } = resolveOpenClawPluginToolInputs({ options: preparedOptions });
          expect(context.browser.allowLocalLoopback).toBe(allowed);
        }
      } finally {
        plugins.mockRestore();
        loadApprovals.mockRestore();
      }
    },
  );
});

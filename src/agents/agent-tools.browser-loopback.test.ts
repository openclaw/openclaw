import { describe, expect, it, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import * as execApprovalsStore from "../infra/exec-approvals-store.js";
import * as execApprovals from "../infra/exec-approvals.js";
import "./test-helpers/fast-bash-tools.js";
import "./test-helpers/fast-coding-tools.js";
import "./test-helpers/fast-openclaw-tools.js";
import {
  createOpenClawCodingTools,
  createOpenClawCodingToolsInternal,
  createOpenClawCodingToolsInternalAsync,
} from "./agent-tools.js";
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
      name: "explicit empty browser policy",
      options: { config: { browser: { ssrfPolicy: {} } } },
      allowed: false,
    },
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
      name: "deployment permits Browser but withholds exec",
      options: {
        config: {
          tools: {
            gatewayPolicy: { allow: ["browser"], actions: { browser: ["open", "navigate"] } },
          },
        },
      },
      allowed: false,
    },
    {
      name: "deployment permits Browser and exec",
      options: {
        config: {
          tools: {
            gatewayPolicy: {
              allow: ["browser", "exec"],
              actions: { browser: ["open", "navigate"] },
            },
          },
        },
      },
      allowed: true,
    },
    {
      name: "deployment withholds exec through an empty action list",
      options: {
        config: {
          tools: {
            gatewayPolicy: {
              allow: ["browser", "exec"],
              actions: { browser: ["open", "navigate"], exec: [] },
            },
          },
        },
      },
      allowed: false,
    },
    {
      name: "inherited runtime tool ceiling",
      options: { runtimeToolAllowlist: ["browser"], inheritRuntimeToolAllowlist: true },
      allowed: false,
    },
  ];

  it.each(["sandbox", "denied exec", "full session"])(
    "does not prepare host approvals for %s",
    async (kind) => {
      const read = vi.spyOn(execApprovalsStore, "prepareExecApprovalsCurrentRead");
      const plugins = vi
        .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptionsAsync")
        .mockResolvedValue([]);
      try {
        await createOpenClawCodingToolsInternalAsync(
          kind === "sandbox"
            ? browserLoopbackCases.find(
                (entry) => entry.name === "sandbox with host browser control",
              )!.options
            : kind === "denied exec"
              ? { config: { tools: { deny: ["exec"] } } }
              : { sessionPermissionPolicy: { root: "/workspace", mode: "full" } },
        );
        expect(read).not.toHaveBeenCalled();
      } finally {
        plugins.mockRestore();
        read.mockRestore();
      }
    },
  );

  it("keeps ordinary tools usable when the optional preview policy owner is unavailable", async () => {
    const read = vi
      .spyOn(execApprovalsStore, "prepareExecApprovalsCurrentRead")
      .mockRejectedValue(new Error("synthetic unavailable policy owner"));
    const plugins = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptionsAsync")
      .mockResolvedValue([]);
    try {
      const tools = await createOpenClawCodingToolsInternalAsync();
      expect(tools.some((tool) => tool.name === "browser")).toBe(true);
      const options = vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0];
      expect(options?.allowLocalBrowserLoopback).toBe(false);
    } finally {
      plugins.mockRestore();
      read.mockRestore();
    }
  });

  it("retires the preview grant when config changes while policy preparation awaits", async () => {
    const config = {};
    const explicitPolicy = { browser: { ssrfPolicy: {} } };
    setRuntimeConfigSnapshot(config);
    const read = vi
      .spyOn(execApprovalsStore, "prepareExecApprovalsCurrentRead")
      .mockImplementation(async () => {
        setRuntimeConfigSnapshot(explicitPolicy);
        return () => ({ version: 1, defaults: { security: "full", ask: "off" } });
      });
    const plugins = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptionsAsync")
      .mockResolvedValue([]);
    try {
      await createOpenClawCodingToolsInternalAsync({ config });
      expect(vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0]?.allowLocalBrowserLoopback).toBe(
        false,
      );
      await createOpenClawCodingToolsInternalAsync({ config: explicitPolicy });
      expect(vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0]?.allowLocalBrowserLoopback).toBe(
        false,
      );
      expect(read).toHaveBeenCalledOnce();
    } finally {
      plugins.mockRestore();
      read.mockRestore();
      clearRuntimeConfigSnapshot();
    }
  });

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

  it("preserves independently authorized native execution when deployment withholds exec", () => {
    const loadApprovals = vi
      .spyOn(execApprovals, "loadExecApprovals")
      .mockReturnValue({ version: 1, defaults: { security: "full", ask: "off" }, agents: {} });
    const plugins = vi
      .spyOn(openClawPluginTools, "resolveOpenClawPluginToolsForOptions")
      .mockReturnValue([]);
    try {
      vi.mocked(createOpenClawTools).mockClear();
      createOpenClawCodingToolsInternal({
        config: {
          tools: {
            gatewayPolicy: { allow: ["browser"], actions: { browser: ["open", "navigate"] } },
          },
        },
        nativeHarnessExecution: true,
      });
      const { context } = resolveOpenClawPluginToolInputs({
        options: vi.mocked(createOpenClawTools).mock.calls.at(-1)?.[0],
      });
      expect(context.browser.allowLocalLoopback).toBe(true);
    } finally {
      plugins.mockRestore();
      loadApprovals.mockRestore();
    }
  });
});

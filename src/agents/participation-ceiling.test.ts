import { describe, expect, it, vi } from "vitest";
import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals-core.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { projectAgentToolsExecPolicy } from "./agent-tools.execution-policy.js";
import { buildEmbeddedAttemptToolRunContext } from "./embedded-agent-runner/run/attempt-tool-run-context.js";
import {
  createEmbeddedRunPermissionChanges,
  withAuthorizedPermissionChange,
} from "./embedded-agent-runner/run/permission-change.js";
import { resolveExecDefaults } from "./exec-defaults.js";
import { preparePluginHarnessParams } from "./harness/plugin-attempt-params.js";
import type { AgentHarness, AgentHarnessAttemptParamsV2 } from "./harness/types.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { PARTICIPATION_RUNTIME_ERROR, type ParticipationCeiling } from "./participation-ceiling.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";

const ceiling: ParticipationCeiling = {
  kind: "send",
  profileId: "participant",
  sessionKey: "agent:main:clamp",
};
const modes: Array<SessionPermissionMode | undefined> = [
  undefined,
  "read-only",
  "guarded",
  "workspace",
  "full",
];
const defaults: Array<ExecMode | undefined> = [
  undefined,
  "deny",
  "allowlist",
  "ask",
  "auto",
  "full",
];
const policies = {
  deny: { security: "deny", ask: "off" },
  allowlist: { security: "allowlist", ask: "off" },
  ask: { security: "allowlist", ask: "on-miss" },
  auto: { security: "allowlist", ask: "on-miss" },
  full: { security: "allowlist", ask: "on-miss" },
} as const;

describe("participation permission intersection", () => {
  it.each(modes.flatMap((permissionMode) => defaults.map((mode) => ({ permissionMode, mode }))))(
    "intersects session=$permissionMode with layered default=$mode without replacing it",
    ({ permissionMode, mode }) => {
      const cfg: OpenClawConfig = { agents: { entries: { main: { tools: { exec: { mode } } } } } };
      const policy = resolveExecDefaults({
        cfg,
        agentId: "main",
        sandboxAvailable: false,
        execApprovals: { version: 1 },
        sessionEntry: { permissionMode },
        participationCeiling: ceiling,
      });
      const expected =
        permissionMode === "read-only"
          ? policies.deny
          : permissionMode
            ? policies.ask
            : policies[mode ?? "full"];
      expect(policy).toMatchObject(expected);
      expect(policy.mode).not.toBe("auto");
      const tools = projectAgentToolsExecPolicy({
        options: {
          config: cfg,
          participationCeiling: ceiling,
          sessionPermissionPolicy: permissionMode
            ? { mode: permissionMode, root: "/workspace" }
            : undefined,
        },
        execConfig: resolveExecToolConfig({ cfg, agentId: "main" }),
        agentId: "main",
        model: {},
      });
      expect(tools).toMatchObject({ ...expected, bypassHostApprovalFloors: false });
    },
  );

  it("retains host floors, model ceilings, and filesystem containment", () => {
    expect(
      resolveExecDefaults({
        participationCeiling: ceiling,
        sessionEntry: { permissionMode: "full" },
        cfg: { tools: { exec: { mode: "full" } } },
        sandboxAvailable: false,
        execApprovals: { version: 1, defaults: { security: "deny", ask: "always" } },
      }),
    ).toMatchObject({ security: "deny", ask: "always" });
    const cfg: OpenClawConfig = {
      tools: { exec: { mode: "full" }, byProvider: { example: { exec: { mode: "deny" } } } },
    };
    expect(
      projectAgentToolsExecPolicy({
        options: { config: cfg, participationCeiling: ceiling },
        execConfig: resolveExecToolConfig({ cfg }),
        model: { provider: "example" },
      }),
    ).toMatchObject({ security: "deny", ask: "off", bypassHostApprovalFloors: false });
    for (const mode of modes) {
      expect(
        prepareCoreToolPolicy({
          config: { tools: { fs: { workspaceOnly: false } } },
          participationCeiling: ceiling,
          sessionPermissionPolicy: mode ? { root: "/workspace", mode } : undefined,
        }),
      ).toMatchObject({
        workspaceOnly: true,
        readOnly: mode === "read-only",
        applyPatchWorkspaceOnly: true,
      });
    }
  });

  it.each(["full", null] as const)(
    "retains the input cap through live %s changes and retry preparation",
    (mode) => {
      const params = {
        permissionMode: "guarded" as SessionPermissionMode | undefined,
        participationCeiling: ceiling,
        execOverrides: {},
      };
      const changes = createEmbeddedRunPermissionChanges(params);
      try {
        const attempt = changes.forAttempt();
        withAuthorizedPermissionChange(attempt.owner, mode, () => {
          void attempt.request(mode);
        });
        expect(changes.prepareRestart()).toBe(true);
        withAuthorizedPermissionChange(attempt.owner, mode, () => attempt.recordApplied(mode));
        expect(params.participationCeiling).toBe(ceiling);
        const cfg: OpenClawConfig = { tools: { exec: { mode: "deny" } } };
        expect(
          projectAgentToolsExecPolicy({
            options: {
              config: cfg,
              participationCeiling: params.participationCeiling,
              exec: params.execOverrides,
              sessionPermissionPolicy: params.permissionMode
                ? { root: "/workspace", mode: params.permissionMode }
                : undefined,
            },
            execConfig: resolveExecToolConfig({ cfg }),
            model: {},
          }),
        ).toMatchObject(
          mode === "full"
            ? { security: "allowlist", ask: "on-miss" }
            : { security: "deny", ask: "off" },
        );
      } finally {
        changes.close();
      }
    },
  );
});

it("never binds the participating device as approval reviewer", () => {
  expect(
    buildEmbeddedAttemptToolRunContext({
      participationCeiling: ceiling,
      approvalReviewerDeviceId: "participant-device",
    }),
  ).toMatchObject({ participationCeiling: ceiling, approvalReviewerDeviceId: undefined });
  expect(
    buildEmbeddedAttemptToolRunContext({ approvalReviewerDeviceId: "owner-device" })
      .approvalReviewerDeviceId,
  ).toBe("owner-device");
});

it.each([false, true])(
  "refuses native harness before native consent=%s can rewrite permissions",
  async (consent) => {
    await expect(
      preparePluginHarnessParams(
        { participationCeiling: ceiling } as AgentHarnessAttemptParamsV2,
        { id: "codex" } as AgentHarness,
        consent,
        vi.fn(),
        false,
      ),
    ).rejects.toThrow(PARTICIPATION_RUNTIME_ERROR);
  },
);

it("filters discovery and exact-id deferred dispatch without invoking forbidden tools", async () => {
  const read = createStubTool("read");
  const denied = [
    "message",
    "sessions_spawn",
    "github_publish",
    "knowledge_remember",
    "computer",
    "browser",
    "openclaw",
    "cron",
    "automations",
    "execute",
  ].map(createStubTool);
  const plugin = createStubTool("web_fetch");
  setPluginToolMeta(plugin, { pluginId: "untrusted-plugin", optional: false });
  for (const tool of [read, plugin, ...denied]) {
    tool.execute = vi.fn(async () => ({ content: [], details: {} }));
  }
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [read, plugin, ...denied] });
  const deniedIds = catalogRef
    .current!.entries.filter((entry) => entry.name !== "read")
    .map((entry) => entry.id);
  const runtime = new ToolSearchRuntime(
    { catalogRef, participationCeiling: ceiling },
    resolveToolSearchConfig(),
  );
  expect(runtime.all().map((entry) => entry.name)).toEqual(["read"]);
  expect(await runtime.search("message")).toEqual([]);
  for (const id of deniedIds) {
    await expect(runtime.describe(id)).rejects.toThrow();
    await expect(runtime.callExactId(id, {})).rejects.toThrow();
  }
  await runtime.call("read", {});
  expect(read.execute).toHaveBeenCalledOnce();
  for (const tool of [plugin, ...denied]) {
    expect(tool.execute).not.toHaveBeenCalled();
  }
});

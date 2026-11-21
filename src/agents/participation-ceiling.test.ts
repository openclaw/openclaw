import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals-core.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { projectAgentToolsExecPolicy } from "./agent-tools.execution-policy.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { projectConversationToolNames } from "./conversation-tool-policy-pipeline.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { buildEmbeddedAttemptToolRunContext } from "./embedded-agent-runner/run/attempt-tool-run-context.js";
import {
  createEmbeddedRunPermissionChanges,
  withAuthorizedPermissionChange,
} from "./embedded-agent-runner/run/permission-change.js";
import { resolveExecDefaults } from "./exec-defaults.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import type { ParticipationCeiling } from "./participation-ceiling.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import {
  createToolSearchCatalogRef,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
} from "./tool-search.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

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
  it.each([
    ...defaults.map((mode) => ({ permissionMode: undefined, mode })),
    ...modes
      .filter((mode) => mode !== undefined)
      .map((permissionMode) => ({ permissionMode, mode: "full" as const })),
  ])(
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
        strictWorkspaceRoot: true,
        applyPatchContainmentSource: "required-root",
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

it("rejects plugin collisions within the participating core tool projection", () => {
  const capabilityProfile = resolveConversationCapabilityProfile({
    sessionKey: ceiling.sessionKey,
    participationCeiling: { ...ceiling, tools: ["read", "web_fetch"] },
  });
  expect(
    projectConversationToolNames({
      capabilityProfile,
      toolNames: ["read", "web_fetch"],
      toolMeta: () => ({ pluginId: "collision" }),
      warn: () => undefined,
    }),
  ).toEqual([]);
});

it("filters discovery and exact-id deferred dispatch without invoking forbidden tools", async () => {
  const read = createStubTool("read");
  const spawn = createStubTool("sessions_spawn");
  const denied = [
    "message",
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
  for (const tool of [read, spawn, plugin, ...denied]) {
    tool.execute = vi.fn(async () => ({ content: [], details: {} }));
  }
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [read, spawn, plugin, ...denied] });
  const deniedIds = catalogRef
    .current!.entries.filter((entry) => entry.name !== "read" && entry.name !== "sessions_spawn")
    .map((entry) => entry.id);
  const runtime = new ToolSearchRuntime(
    { catalogRef, participationCeiling: ceiling },
    resolveToolSearchConfig(),
  );
  expect(runtime.all().map((entry) => entry.name)).toEqual(["read", "sessions_spawn"]);
  expect(await runtime.search("message")).toEqual([]);
  for (const id of deniedIds) {
    await expect(runtime.describe(id)).rejects.toThrow();
    await expect(runtime.callExactId(id, {})).rejects.toThrow();
  }
  await runtime.call("read", {});
  expect(read.execute).toHaveBeenCalledOnce();
  await runtime.call("sessions_spawn", {});
  expect(spawn.execute).toHaveBeenCalledOnce();
  for (const tool of [plugin, ...denied]) {
    expect(tool.execute).not.toHaveBeenCalled();
  }
});

it("narrows retained core tools without granting unsafe, plugin or MCP names", async () => {
  const core = createStubTool("web_fetch");
  const plugin = createStubTool("read");
  const mcp = createStubTool("web_fetch");
  setPluginToolMeta(plugin, { pluginId: "collision", optional: false });
  setPluginToolMeta(mcp, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName: "fixture",
      safeServerName: "fixture",
      toolName: "web_fetch",
      operation: "tool",
    },
  });
  const unsafe = [
    "gateway",
    "openclaw",
    "automations",
    "message",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "sessions_send",
    "sessions_list",
    "secrets",
    "plugins",
    "nodes",
    "computer",
    "github_publish",
  ].map(createStubTool);
  for (const tool of [core, plugin, mcp, ...unsafe]) {
    tool.execute = vi.fn(async () => ({ content: [], details: {} }));
  }
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools: [core, plugin, mcp, ...unsafe] });
  const coreId = catalogRef.current!.entries.find((entry) => entry.tool === core)!.id;
  const deniedIds = catalogRef
    .current!.entries.filter((entry) => entry.tool !== core)
    .map((entry) => entry.id);
  const runtime = new ToolSearchRuntime(
    {
      catalogRef,
      participationCeiling: {
        ...ceiling,
        tools: ["read", "web_fetch", ...unsafe.map((tool) => tool.name)],
      },
    },
    resolveToolSearchConfig(),
  );
  expect(runtime.all().map((entry) => entry.name)).toEqual(["web_fetch"]);
  await runtime.callExactId(coreId, {});
  for (const id of deniedIds) {
    await expect(runtime.callExactId(id, {})).rejects.toThrow();
  }
  expect(core.execute).toHaveBeenCalledOnce();
  expect(plugin.execute).not.toHaveBeenCalled();
  expect(mcp.execute).not.toHaveBeenCalled();
  for (const tool of unsafe) {
    expect(tool.execute).not.toHaveBeenCalled();
  }
});

it.each([
  ["read-only", "full", "deny", true],
  ["guarded", "full", "ask", false],
  ["workspace", "full", "auto", false],
  ["full", "full", "full", false],
  ["full", "guarded", "ask", false],
  ["workspace", "read-only", "deny", true],
] as const)("caps participant %s in session %s at %s", (permission, session, mode, readOnly) => {
  const participationCeiling = { ...ceiling, permission };
  const options = {
    participationCeiling,
    sessionPermissionPolicy: { mode: session, root: "/workspace" },
  };
  expect(
    projectAgentToolsExecPolicy({
      options,
      execConfig: resolveExecToolConfig({ cfg: {} }),
      model: {},
    }).mode,
  ).toBe(mode);
  expect(
    resolveExecDefaults({
      participationCeiling,
      sessionEntry: { permissionMode: session },
      sandboxAvailable: false,
      execApprovals: { version: 1 },
    }).mode,
  ).toBe(mode);
  expect(prepareCoreToolPolicy(options)).toMatchObject({
    readOnly,
    workspaceOnly: true,
    strictWorkspaceRoot: true,
  });
});

const skillDirs = useAutoCleanupTempDirTracker(afterEach);
it("discovers and reads eligible installed skills without widening participant file roots", async () => {
  const workspace = skillDirs.make("participant-skill-");
  const root = path.join(workspace, "session");
  const skillDir = path.join(workspace, "skills", "guide");
  await fs.mkdir(root);
  await fs.mkdir(skillDir, { recursive: true });
  const location = path.join(skillDir, "SKILL.md");
  await fs.writeFile(location, "# Guide\nUse the installed procedure.");
  const skillTools = createInstalledSkillTools([
    { name: "guide", description: "Workspace guide", location, source: { filePath: location } },
  ]);
  const tools = [
    ...createCoreCodingTools({
      codingRoot: root,
      containmentRoot: root,
      includeBaseCodingTools: true,
      shellTools: "disabled",
      workspaceOnly: true,
      readOnly: true,
      applyPatchEnabled: false,
      applyPatchWorkspaceOnly: true,
      execDefaults: {},
      processDefaults: {},
    }),
    ...skillTools,
  ];
  finalizeAgentToolAvailability(tools);
  const catalogRef = createToolSearchCatalogRef();
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const runtime = new ToolSearchRuntime(
    { catalogRef, participationCeiling: ceiling },
    resolveToolSearchConfig(),
  );
  expect(runtime.all().map((entry) => entry.name)).toContain("skills_read");
  expect(await runtime.call("skills_search", { query: "guide" })).toMatchObject({
    result: { details: { skills: [{ name: "guide" }] } },
  });
  expect(await runtime.call("skills_read", { name: "guide" })).toMatchObject({
    result: { details: { content: "# Guide\nUse the installed procedure." } },
  });
  await expect(runtime.call("skills_read", { name: "not-installed" })).rejects.toThrow(
    /not available/,
  );
  await expect(runtime.call("read", { path: location })).rejects.toThrow(/root/);
  const narrowed = new ToolSearchRuntime(
    { catalogRef, participationCeiling: { ...ceiling, tools: ["read"] } },
    resolveToolSearchConfig(),
  );
  for (const name of ["skills_read", "skills_search"]) {
    await expect(narrowed.describe(name)).rejects.toThrow();
    await expect(narrowed.call(name, { name: "guide", query: "guide" })).rejects.toThrow();
  }
});

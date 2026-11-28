import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPermissionMode } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecMode } from "../infra/exec-approvals-core.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { projectAgentToolsExecPolicy } from "./agent-tools.execution-policy.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { projectConversationToolNames } from "./conversation-tool-policy-pipeline.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import {
  createEmbeddedRunPermissionChanges,
  withAuthorizedPermissionChange,
} from "./embedded-agent-runner/run/permission-change.js";
import { resolveExecDefaults } from "./exec-defaults.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import {
  DEFAULT_PARTICIPATION_TOOLS,
  filterParticipationTools,
  intersectParticipationCeilings,
  resolveParticipationTools,
  type ParticipationCeiling,
} from "./participation-ceiling.js";
import {
  createParticipationTestAuthority,
  prepareParticipationTestRun,
} from "./participation-ceiling.test-support.js";
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

it("enforces admitted-only permission, filesystem and exact-ID tool policy", async () => {
  const authority = createParticipationTestAuthority({
    ...ceiling,
    permission: "read-only",
    tools: ["read"],
  });
  const admission = prepareSystemAgentRunAdmission(
    {},
    "authority-only",
    "main",
    "test",
    undefined,
    authority,
  );
  try {
    const options = {
      pluginExecutionAuthority: readAdmittedRunOperatorAuthority(await admission.admit("embedded")),
      sessionPermissionPolicy: { mode: "full" as const, root: "/workspace" },
    };
    expect(
      projectAgentToolsExecPolicy({ options, execConfig: resolveExecToolConfig({}), model: {} }),
    ).toMatchObject({ security: "deny", bypassHostApprovalFloors: false });
    expect(prepareCoreToolPolicy(options)).toMatchObject({
      readOnly: true,
      strictWorkspaceRoot: true,
    });
    const read = createStubTool("read");
    const write = createStubTool("write");
    write.execute = vi.fn();
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools: [read, write] });
    const writeId = catalogRef.current!.entries.find((entry) => entry.name === "write")!.id;
    const runtime = new ToolSearchRuntime({ catalogRef, ...options }, resolveToolSearchConfig());
    expect(runtime.all().map((entry) => entry.name)).toEqual(["read"]);
    await expect(runtime.callExactId(writeId, {})).rejects.toThrow();
    expect(write.execute).not.toHaveBeenCalled();
  } finally {
    admission.close();
  }
});

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
          ...prepareParticipationTestRun(ceiling),
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
        options: { config: cfg, ...prepareParticipationTestRun(ceiling) },
        execConfig: resolveExecToolConfig({ cfg }),
        model: { provider: "example" },
      }),
    ).toMatchObject({ security: "deny", ask: "off", bypassHostApprovalFloors: false });
    for (const mode of modes) {
      expect(
        prepareCoreToolPolicy({
          config: { tools: { fs: { workspaceOnly: false } } },
          ...prepareParticipationTestRun(ceiling),
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
        ...prepareParticipationTestRun(ceiling),
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
        expect(
          params.preparedRunAdmission.readOperatorAuthority?.()?.participationCeiling,
        ).toMatchObject(ceiling);
        const cfg: OpenClawConfig = { tools: { exec: { mode: "deny" } } };
        expect(
          projectAgentToolsExecPolicy({
            options: {
              config: cfg,
              pluginExecutionAuthority: params.pluginExecutionAuthority,
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

it.each([
  { policy: undefined, extra: [], replaced: false },
  { policy: { invitedAlsoAllow: [] }, extra: [], replaced: false },
  {
    policy: {
      invitedAlsoAllow: ["group:messaging", "knowledge_*", "mcp:fixture:*", "read", "openclaw"],
    },
    extra: ["group:messaging", "knowledge_*", "mcp:fixture:*", "openclaw"],
    replaced: false,
  },
  { policy: { invitedTools: [] }, extra: [], replaced: true },
  {
    policy: { invitedTools: ["knowledge_*", "openclaw"] },
    extra: ["knowledge_*", "openclaw"],
    replaced: true,
  },
])("resolves participant replacement/addition $policy", ({ policy, extra, replaced }) => {
  const tools = resolveParticipationTools(policy);
  expect(tools).toEqual(replaced ? extra : [...DEFAULT_PARTICIPATION_TOOLS, ...extra]);
  expect(filterParticipationTools([{ name: "openclaw" }], { ...ceiling, tools })).toEqual([]);
});

it.each([
  [
    ["group:fs", "knowledge_*"],
    ["read", "knowledge_record"],
  ],
  [["fixture"], ["knowledge_record"]],
  [["*"], ["read", "knowledge_record", "message"]],
  [[], []],
] as [string[], string[]][])("projects configured participant policy %j", (tools, expected) => {
  const capabilityProfile = resolveConversationCapabilityProfile({
    sessionKey: ceiling.sessionKey,
    ...prepareParticipationTestRun({ ...ceiling, tools }),
  });
  expect(
    projectConversationToolNames({
      capabilityProfile,
      toolNames: ["read", "knowledge_record", "message", "openclaw"],
      toolMeta: (tool) => (tool.name === "knowledge_record" ? { pluginId: "fixture" } : undefined),
      warn: () => undefined,
    }),
  ).toEqual(expected);
});

it("retains both patterned restrictions through JSON recovery and later widening", () => {
  const first = intersectParticipationCeilings(
    { ...ceiling, tools: ["knowledge_*"] },
    { ...ceiling, tools: ["*_record"] },
  );
  const serialized = JSON.stringify(first);
  // SAFETY: this round-trip contains only the locally constructed ceiling above.
  const retained = JSON.parse(serialized) as ParticipationCeiling;
  const participationCeiling = intersectParticipationCeilings(retained, {
    ...ceiling,
    tools: ["*"],
  });
  expect(
    projectConversationToolNames({
      capabilityProfile: resolveConversationCapabilityProfile({
        sessionKey: ceiling.sessionKey,
        ...prepareParticipationTestRun(participationCeiling!),
      }),
      toolNames: ["knowledge_record", "knowledge_remember", "other_record", "openclaw"],
      warn: () => undefined,
    }),
  ).toEqual(["knowledge_record"]);
});

it.each([
  {
    name: "default tools",
    tools: ["read", "sessions_spawn", "sessions_yield"],
    allowed: ["read", "sessions_spawn", "sessions_yield"],
  },
  {
    name: "configured plugin and MCP tools",
    tools: ["knowledge", "fixture__*", "openclaw"],
    allowed: ["fixture__read", "knowledge_record"],
  },
])(
  "filters discovery and exact-ID dispatch for $name without forbidden effects",
  async (scenario) => {
    const tools = [
      "read",
      "sessions_spawn",
      "sessions_yield",
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
    const untrusted = createStubTool("web_fetch");
    const plugin = createStubTool("knowledge_record");
    const mcp = createStubTool("fixture__read");
    setPluginToolMeta(untrusted, { pluginId: "untrusted-plugin", optional: false });
    setPluginToolMeta(plugin, { pluginId: "knowledge", optional: false });
    setPluginToolMeta(mcp, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "fixture",
        safeServerName: "fixture",
        toolName: "read",
        operation: "tool",
      },
    });
    tools.push(untrusted, plugin, mcp);
    for (const tool of tools) {
      tool.execute = vi.fn(async () => ({ content: [], details: {} }));
    }
    const catalogRef = createToolSearchCatalogRef();
    registerHeadlessToolSearchCatalog({ catalogRef, tools });
    const runtime = new ToolSearchRuntime(
      { catalogRef, ...prepareParticipationTestRun({ ...ceiling, tools: scenario.tools }) },
      resolveToolSearchConfig(),
    );
    expect(runtime.all().map((entry) => entry.name)).toEqual(scenario.allowed);
    expect(await runtime.search("message")).toEqual([]);
    for (const entry of catalogRef.current!.entries) {
      if (scenario.allowed.includes(entry.name)) {
        await runtime.call(entry.name, {});
        await runtime.callExactId(entry.id, {});
      } else {
        await expect(runtime.describe(entry.id)).rejects.toThrow();
        await expect(runtime.callExactId(entry.id, {})).rejects.toThrow();
      }
    }
    for (const tool of tools) {
      expect(tool.execute).toHaveBeenCalledTimes(scenario.allowed.includes(tool.name) ? 2 : 0);
    }
  },
);

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
    ...prepareParticipationTestRun(participationCeiling),
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
    { catalogRef, ...prepareParticipationTestRun(ceiling) },
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
    { catalogRef, ...prepareParticipationTestRun({ ...ceiling, tools: ["ls"] }) },
    resolveToolSearchConfig(),
  );
  for (const name of ["skills_read", "skills_search"]) {
    await expect(narrowed.describe(name)).rejects.toThrow();
    await expect(narrowed.call(name, { name: "guide", query: "guide" })).rejects.toThrow();
  }
});

it("does not lend a participant another turn's runtime yield claim", async () => {
  const runtimeClaim = vi.fn(() => true);
  const claim = createRequesterYieldCallback({
    ...prepareParticipationTestRun(ceiling),
    requesterAgentId: "main",
    requesterSessionKey: ceiling.sessionKey,
    claimYieldCompletion: runtimeClaim,
  });
  expect(await claim?.()).toBe(false);
  expect(runtimeClaim).not.toHaveBeenCalled();
});

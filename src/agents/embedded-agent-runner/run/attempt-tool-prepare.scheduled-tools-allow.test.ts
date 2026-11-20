// A scheduled run's toolsAllow is an authority boundary: keeping the session's tools listed
// must refuse exactly the calls the allowlist refused when it removed those tools.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getInternalToolExecutionPreparer } from "../../../../packages/agent-core/src/internal-hooks.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../../config/io.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import { getPluginToolMeta, setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { rewrapToolWithBeforeToolCallHook } from "../../agent-tools.before-tool-call.wrapper.js";
import { runWithAgentRingZeroTools } from "../../agent-tools.ring-zero-context.js";
import { PARTICIPATION_TOOL_ALLOWLIST } from "../../participation-ceiling.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import type { AnyAgentTool } from "../../tools/common.js";
import { prepareEmbeddedAttemptBundleTools } from "./attempt-bundle-tools.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptToolCatalog } from "./attempt-tool-catalog.js";
import { prepareEmbeddedAttemptToolBase } from "./attempt-tool-prepare.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

// One MCP-backed plugin tool the allowlist does not name.
const pluginToolAllowlists: Array<string[] | undefined> = [];
vi.mock("../../openclaw-plugin-tools.js", async (importOriginal) => {
  const pluginTools = (params?: { options?: { pluginToolAllowlist?: string[] } }) => {
    pluginToolAllowlists.push(params?.options?.pluginToolAllowlist);
    const tool = createStubTool("world__calendar_list");
    setPluginToolMeta(tool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "world",
        safeServerName: "world",
        toolName: "calendar_list",
        operation: "tool",
      },
    });
    return [tool];
  };
  return {
    ...(await importOriginal<typeof import("../../openclaw-plugin-tools.js")>()),
    resolveOpenClawPluginToolsForOptions: pluginTools,
    resolveOpenClawPluginToolsForOptionsAsync: async (params: {
      options?: { pluginToolAllowlist?: string[] };
    }) => pluginTools(params),
  };
});

// No bundle MCP servers in this harness (MCP keeps main's start rule; out of scope).
vi.mock("../../agent-bundle-mcp-tools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agent-bundle-mcp-tools.js")>()),
  acquireSessionMcpRuntime: async () => undefined,
}));

// Records whether each run may build the computer schema.
const computerAllowedByRun: boolean[] = [];
vi.mock("../../computer-use-node-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../computer-use-node-capabilities.js")>()),
  loadPairedComputerUseAvailabilityForSurface: async (params: { computerAllowed: boolean }) => {
    computerAllowedByRun.push(params.computerAllowed);
    return undefined;
  },
}));

const baseConfig: OpenClawConfig = {
  agents: { entries: { main: {} } },
  tools: {
    profile: "coding",
    alsoAllow: ["world__calendar_list"],
    codeMode: false,
    toolSearch: { enabled: true, mode: "tools" },
  },
};
const sessionKey = "agent:main:telegram:direct:owner";
// Names, a group, a glob, and `message`, which the allowlist adds over the coding profile.
const toolsAllow = ["read", "group:web", "sessions_*", "message"];

async function prepareTools(
  overrides: Partial<EmbeddedRunAttemptInternalParams>,
  config: OpenClawConfig = baseConfig,
  // Calls this tool through a catalog rewrap of its hook layer, as dispatch_action does.
  dispatchTool?: string,
) {
  setRuntimeConfigSnapshot(config);
  await using resources = new AsyncDisposableStack();
  const runId = overrides.runId ?? "run";
  const admission = prepareSystemAgentRunAdmission(config, runId, "main", "test");
  resources.defer(() => admission.close());
  const attempt = {
    config,
    runId,
    sessionId: "scheduled-tools-allow",
    sessionKey: overrides.sessionKey ?? sessionKey,
    messageProvider: "telegram",
    messageTo: "telegram:owner",
    provider: "openai",
    modelId: "gpt-5.4",
    model: makeProviderModelFixture({
      id: "gpt-5.4",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
    authProfileStore: { version: 1, profiles: {} },
    admittedRunContext: await admission.admit("embedded"),
    ...overrides,
  } as EmbeddedRunAttemptInternalParams;
  const result = await prepareEmbeddedAttemptToolBase({
    attempt,
    agentDir: "/tmp/openclaw-scheduled-tools-allow-agent",
    setup: createAttemptSetupFixture({ sandboxSessionKey: sessionKey }),
    markCoreToolStage: () => {},
    onYield: async () => {},
    runAbortController: new AbortController(),
    runTrace: { traceId: "1234567890abcdef1234567890abcdef" },
    skillUsagePaths: [],
    skillsSnapshot: undefined,
    codeModeSkills: [],
    toolSearchCatalogExecutor: async () => ({ content: [], details: {} }),
  });
  resources.defer(() => result.toolSurfaceRuntime.cleanup());
  resources.defer(() => result.releaseTools("test-complete"));
  const setup = createAttemptSetupFixture({ sandboxSessionKey: sessionKey });
  // The production bundle pass: final policy, delegation and cron-creator capture.
  const bundle = await prepareEmbeddedAttemptBundleTools({
    agentDir: "/tmp/openclaw-scheduled-tools-allow-agent",
    attempt,
    setup,
    isRawModelRun: false,
    preparedToolBase: result,
  });
  const tools = bundle.uncompactedEffectiveTools as AnyAgentTool[];
  const catalog = await prepareEmbeddedAttemptToolCatalog({
    attempt,
    setup,
    preparedToolBase: result,
    bundleTools: bundle,
    abortSignal: result.toolAbortSignal,
    executeCodeModeTool: async () => ({ content: [], details: {} }),
  });
  const target = dispatchTool && tools.find((tool) => tool.name === dispatchTool);
  const dispatched = target
    ? await rewrapToolWithBeforeToolCallHook(target).execute("dispatch", { command: "true" })
    : undefined;
  // Execute every listed tool through the direct, preparer and dispatch paths.
  const refusals = await Promise.all(
    tools.map(
      async (tool) =>
        [tool.name, await refusedVia(tool, Boolean(overrides.participationCeiling))] as const,
    ),
  );
  return {
    dispatched,
    emptyAllowlistError: catalog.emptyExplicitToolAllowlistError?.message,
    listed: tools.map((tool) => tool.name).toSorted(),
    callable: (
      await Promise.all(tools.map(async (tool) => ((await executes(tool)) ? [tool.name] : [])))
    )
      .flat()
      .toSorted(),
    refusals,
    inherited: result.inheritedToolAllowlist
      ? [...result.inheritedToolAllowlist].toSorted()
      : undefined,
    cronCreator: result.cronCreatorToolAllowlist
      ? result.cronCreatorToolAllowlist
          .map((entry) => (typeof entry === "string" ? entry : entry.name))
          .toSorted()
      : undefined,
    tools,
  };
}

const isGated = (value: unknown) =>
  (value as { details?: { gated?: unknown } } | undefined)?.details?.gated === true;

/**
 * Awaits a call to completion, so no call outlives its test and holds a plugin instance open
 * (the forced-retirement failure seen under load came from abandoned calls).
 */
async function settle(run: () => Promise<unknown>): Promise<unknown> {
  return run().catch(() => undefined);
}
const aborted = AbortSignal.abort();

/** Arguments that satisfy a tool's required schema fields with placeholder values. */
function placeholderArgs(schema: unknown): unknown {
  const node = (schema ?? {}) as {
    type?: string | string[];
    enum?: unknown[];
    const?: unknown;
    anyOf?: unknown[];
    oneOf?: unknown[];
    properties?: Record<string, unknown>;
    required?: string[];
  };
  if (node.const !== undefined) {
    return node.const;
  }
  if (node.enum?.length) {
    return node.enum[0];
  }
  const variant = node.anyOf?.[0] ?? node.oneOf?.[0];
  if (variant) {
    return placeholderArgs(variant);
  }
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  if (type === "object" || node.properties) {
    return Object.fromEntries(
      (node.required ?? []).map((key) => [key, placeholderArgs(node.properties?.[key])]),
    );
  }
  return type === "number" || type === "integer"
    ? 1
    : type === "boolean"
      ? false
      : type === "array"
        ? []
        : "/nonexistent/openclaw-scheduled-tools-allow";
}

/**
 * A tool executes when a call with schema-valid arguments passes every gate, starts the
 * implementation (the agent loop's preparer path) and does not come back refused. Refusals,
 * validation errors, and exceptions or timeouts before the implementation starts count as
 * not executed. Placeholder paths and commands point nowhere, so started work fails inertly; the
 * probe awaits it, so no call outlives its test.
 */
async function executes(tool: AnyAgentTool): Promise<boolean> {
  const preparer = getInternalToolExecutionPreparer(tool);
  if (!preparer) {
    return false;
  }
  let started = false;
  let refused = false;
  await settle(async () => {
    const step = await preparer({
      toolCallId: "executes",
      args: placeholderArgs(tool.parameters),
    });
    try {
      if (step.kind === "ready") {
        const result = step.execute(() => {
          started = true;
        });
        refused = isGated(await result);
      }
    } finally {
      step.dispose();
    }
  });
  return started && !refused;
}

async function refusedVia(tool: AnyAgentTool, validArgs = false) {
  const args = validArgs ? placeholderArgs(tool.parameters) : {};
  const signal = validArgs ? undefined : aborted;
  const direct = isGated(await settle(() => tool.execute("direct", args, signal)));
  const preparer = getInternalToolExecutionPreparer(tool);
  const prepared = preparer
    ? await settle(async () => {
        const step = await preparer({ toolCallId: "prepared", args, signal });
        try {
          return step.kind === "ready" ? await step.execute() : step;
        } finally {
          step.dispose();
        }
      })
    : undefined;
  const viaPreparer = preparer
    ? isGated(prepared) || isGated((prepared as { result?: unknown } | undefined)?.result)
    : direct;
  const dispatch = isGated(
    await settle(() => rewrapToolWithBeforeToolCallHook(tool).execute("dispatch", args, signal)),
  );
  return { direct, preparer: viaPreparer, dispatch };
}

const scheduled = {
  runId: "scheduled",
  trigger: "cron",
  toolsAllow,
  senderIsOwner: false,
} as const;

beforeEach(() => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram" }),
          actions: { describeMessageTool: () => ({ actions: ["send"] }) },
        },
      },
    ]),
  );
});
afterEach(() => clearRuntimeConfigSnapshot());

// Recorded on the merge base, where the allowlist removed every other tool from the list.
const callableOnBase = [
  "dispatch_action",
  "message",
  "read",
  "sessions_create",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "tool_describe",
  "tool_search",
  "web_fetch",
];

it("keeps the session's tools listed on a scheduled run and refuses the rest visibly", async () => {
  const run = await prepareTools(scheduled, baseConfig, "exec");
  const user = await prepareTools({ runId: "user", trigger: "user", senderIsOwner: true });
  expect(run.listed).toEqual(user.listed);
  expect(run.dispatched?.details).toMatchObject({ gated: true });
  expect(JSON.stringify(run.dispatched?.content)).toContain(
    "exec is outside the tools this run allows",
  );
  // A refused MCP tool keeps its provenance, so the catalog still treats it as MCP.
  const mcp = run.tools.find((tool) => tool.name === "world__calendar_list")!;
  expect(getPluginToolMeta(mcp)?.mcp?.serverName).toBe("world");
});

it("still fails a scheduled run whose allowlist matches no tool", async () => {
  const run = await prepareTools({ ...scheduled, toolsAllow: ["query_db"] });
  expect(run.emptyAllowlistError).toContain("No callable tools remain");
  expect(run.emptyAllowlistError).toContain("runtime toolsAllow: query_db");
});

// The guest sender's policy and every run allowlist refuse what main removed from the list.
const guestConfig: OpenClawConfig = {
  ...baseConfig,
  tools: {
    ...baseConfig.tools,
    toolsBySender: { "id:guest": { deny: ["exec", "process", "write", "edit", "apply_patch"] } },
  },
};
const refusalCases = [
  { name: "cron toolsAllow", overrides: scheduled, config: baseConfig },
  {
    name: "user toolsAllow",
    overrides: { ...scheduled, runId: "u", trigger: "user" },
    config: baseConfig,
  },
  {
    name: "event toolsAllow",
    overrides: { ...scheduled, runId: "e", trigger: "event" },
    config: baseConfig,
  },
  {
    name: "group guest sender",
    overrides: {
      runId: "g",
      trigger: "user",
      sessionKey: "agent:main:telegram:group:g1",
      senderId: "guest",
      senderIsOwner: false,
    },
    config: guestConfig,
  },
  {
    name: "group owner sender",
    overrides: {
      runId: "o",
      trigger: "user",
      sessionKey: "agent:main:telegram:group:g1",
      senderId: "owner",
      senderIsOwner: true,
    },
    config: guestConfig,
  },
] as const;

// Recorded on main, where each policy removed the tools it refuses from the list.
const guestCallable = [
  "agents_wait",
  "create_goal",
  "dashboard",
  "dispatch_action",
  "get_goal",
  "ls",
  "presence",
  "progress_card",
  "read",
  "secrets",
  "session_status",
  "sessions",
  "sessions_create",
  "sessions_history",
  "sessions_list",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "theme",
  "tool_describe",
  "tool_search",
  "update_goal",
  "web_fetch",
  "world__calendar_list",
];
const expectedCallable: Record<(typeof refusalCases)[number]["name"], readonly string[]> = {
  "cron toolsAllow": callableOnBase,
  "user toolsAllow": callableOnBase,
  "event toolsAllow": callableOnBase,
  "group guest sender": guestCallable,
  "group owner sender": [
    ...guestCallable,
    "apply_patch",
    "automations",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "edit",
    "exec",
    "gateway",
    "plugins",
    "portal",
    "process",
    "terminal",
    "write",
  ].toSorted(),
};

it.each(refusalCases)("allows exactly the calls main allowed: $name", async (c) => {
  const run = await prepareTools(c.overrides as never, c.config);
  expect(run.callable).toEqual(expectedCallable[c.name]);
  // Direct calls, the preparer the agent loop prefers, and dispatch_action agree.
  for (const [name, refused] of run.refusals) {
    expect({ name, ...refused }).toEqual({
      name,
      direct: refused.direct,
      preparer: refused.direct,
      dispatch: refused.direct,
    });
  }
});

it("lists one tool set for every sender of a group and refuses the guest through dispatch", async () => {
  const guest = await prepareTools(refusalCases[3].overrides as never, guestConfig, "exec");
  const owner = await prepareTools(refusalCases[4].overrides as never, guestConfig);
  expect(guest.listed).toEqual(owner.listed);
  expect(guest.dispatched?.details).toMatchObject({ gated: true });
});

const guestGroup = {
  runId: "g",
  trigger: "user",
  sessionKey: "agent:main:telegram:group:g1",
  senderId: "guest",
  senderIsOwner: false,
} as const;
const withSenderPolicy = (policy: Record<string, unknown>): OpenClawConfig => ({
  ...baseConfig,
  tools: { ...baseConfig.tools, toolsBySender: { "id:guest": policy } },
});

it("fails loudly when only refused tools remain", async () => {
  // A sender allowlist with a typo, and a run allowlist naming only a tool the sender may not use.
  const typo = await prepareTools(guestGroup, withSenderPolicy({ allow: ["raed"] }));
  expect(typo.emptyAllowlistError).toContain("No callable tools remain");
  const refusedOnly = await prepareTools(
    { ...guestGroup, toolsAllow: ["exec"] },
    withSenderPolicy({ deny: ["exec"] }),
  );
  expect(refusedOnly.emptyAllowlistError).toContain("No callable tools remain");
});

it("keeps today's verdict for an allowlist naming an owner-only tool on a non-owner turn", async () => {
  // Owner authority gates the call, as on main; the allowlist did match a tool.
  const run = await prepareTools({ runId: "o2", trigger: "user", toolsAllow: ["automations"] });
  expect(run.emptyAllowlistError).toBeUndefined();
});

it("refuses what a sender allow policy removed", async () => {
  const allow = await prepareTools(guestGroup, withSenderPolicy({ allow: ["read", "sessions_*"] }));
  expect(allow.callable).toEqual([
    "dispatch_action",
    "read",
    "sessions_create",
    "sessions_history",
    "sessions_list",
    "sessions_search",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "tool_describe",
    "tool_search",
  ]);
});

it("never delegates or captures a tool the guest sender is refused", async () => {
  const run = await prepareTools(
    { ...guestGroup, trigger: "user" },
    withSenderPolicy({ deny: ["exec", "world__calendar_list"] }),
  );
  const owner = await prepareTools({ ...guestGroup, senderId: "owner", senderIsOwner: true });
  // A guest's deny refuses a plugin tool without dropping it from the owner's list.
  expect(run.listed).toEqual(owner.listed);
  expect(run.callable).not.toContain("world__calendar_list");
  expect(run.inherited?.length).toBeGreaterThan(0);
  expect(run.cronCreator?.length).toBeGreaterThan(0);
  for (const name of ["exec", "world__calendar_list"]) {
    expect(run.inherited ?? []).not.toContain(name);
    expect(run.cronCreator ?? []).not.toContain(name);
  }
});

it("keeps removing a host ring-zero tool the run allowlist does not name", async () => {
  // Ring-zero tools join after agent policy. Their harness runs without Tool Search, so
  // the allowlist still narrows the list there, as on main.
  const run = await runWithAgentRingZeroTools([createStubTool("host_probe")], () =>
    prepareTools({ ...scheduled, runId: "ring" }),
  );
  expect(run.listed).not.toContain("tool_search");
  expect(run.listed).not.toContain("host_probe");
});

it("keeps a sender's optional-plugin grant when building the fixed listing", async () => {
  pluginToolAllowlists.length = 0;
  await prepareTools(guestGroup, withSenderPolicy({ allow: ["diffs"] }));
  // The grant still reaches plugin construction, beside the default plugin tools.
  expect(pluginToolAllowlists.at(-1)).toEqual(
    expect.arrayContaining(["diffs", "__openclaw_default_plugin_tools__"]),
  );
});

it("decides the computer schema from session facts, whatever the run allowlist names", async () => {
  const config = {
    ...baseConfig,
    tools: { ...baseConfig.tools, alsoAllow: ["world__calendar_list", "computer"] },
  };
  computerAllowedByRun.length = 0;
  await prepareTools({ ...scheduled, toolsAllow: ["read"] }, config);
  await prepareTools({ runId: "user", trigger: "user", senderIsOwner: true }, config);
  expect(computerAllowedByRun).toEqual([true, true]);
});

it("builds a registration-denied tool for the owner's list and refuses it for the guest", async () => {
  // progress_card registration reads the plugin denylist; a guest deny must not drop it.
  const config = withSenderPolicy({ deny: ["progress_card"] });
  const guest = await prepareTools(guestGroup, config);
  const owner = await prepareTools(
    { ...guestGroup, senderId: "owner", senderIsOwner: true },
    config,
  );
  expect(owner.listed).toContain("progress_card");
  expect(guest.listed).toEqual(owner.listed);
  expect(guest.callable).not.toContain("progress_card");
});

it("narrows an isolated cron session to its allowlist and keeps a shared session's list fixed", async () => {
  const isolated = await prepareTools({
    ...scheduled,
    runId: "iso",
    sessionKey: "agent:main:cron:nightly:run:r1",
  });
  const shared = await prepareTools({ ...scheduled, runId: "shared" });
  // One run per isolated session: nothing to share, so it sends main's narrowed list.
  expect(isolated.listed).not.toContain("exec");
  expect(isolated.listed).toEqual(isolated.callable);
  expect(shared.listed).toContain("exec");
  expect(shared.callable).toEqual(isolated.callable);
});

it("keeps participation tools gated through direct calls, preparers, and deferred dispatch", async () => {
  const participationCeiling = { kind: "send" as const, profileId: "guest", sessionKey };
  const config = { ...baseConfig, tools: { ...baseConfig.tools, alsoAllow: ["*"] } };
  const run = await prepareTools(
    {
      runId: "participant",
      trigger: "user",
      senderIsOwner: true,
      participationCeiling,
      approvalReviewerDeviceId: "guest-device",
    },
    config,
    "world__calendar_list",
  );
  expect(run.callable.length).toBeGreaterThan(0);
  expect(run.callable.every((name) => PARTICIPATION_TOOL_ALLOWLIST.includes(name))).toBe(true);
  expect(run.dispatched?.details).toMatchObject({ gated: true });
  for (const [name, refused] of run.refusals) {
    if (!PARTICIPATION_TOOL_ALLOWLIST.includes(name)) {
      expect({ name, ...refused }).toEqual({ name, direct: true, preparer: true, dispatch: true });
    }
  }
  const ordinary = await prepareTools(
    { runId: "ordinary", trigger: "user", senderIsOwner: true },
    config,
  );
  expect(run.listed).toEqual(ordinary.listed);
});

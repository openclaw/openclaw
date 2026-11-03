/** Canonical tool identities and policy facts, independent of catalog presentation. */
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";

// Shared with restart classification without importing the tool-search runtime contract.
export const TOOL_CALL_RAW_TOOL_NAME = "dispatch_action";

/** Built-in tool profile ids exposed in config and UI. */
export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

/** Allow/deny policy generated from a built-in tool profile. */
type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

export type CoreToolFactoryFamily = "base-coding" | "shell" | "openclaw";

type CoreToolFacts = {
  factoryFamily?: CoreToolFactoryFamily;
  // Recorded-call replay and blind attempt retry have distinct audited allowlists.
  replay?: "both" | "blind" | "recorded";
};

export type CoreToolDefinition = CoreToolFacts & {
  id: string;
  sectionId: string;
  profiles: ToolProfileId[];
  executionLocation?: "placement" | "gateway";
  includeInSectionGroup?: boolean;
  includeInOpenClawGroup?: boolean;
};

type CoreToolOptions = Omit<CoreToolDefinition, "id" | "sectionId">;

function coreTools<const Id extends string>(
  sectionId: string,
  defaults: CoreToolOptions,
  tools: Array<[id: Id, options?: Partial<CoreToolOptions>]>,
): Array<CoreToolDefinition & { id: Id }> {
  return tools.map(([id, options]) => ({
    id,
    sectionId,
    factoryFamily: "openclaw",
    ...defaults,
    ...options,
  }));
}

export const CORE_TOOL_DEFINITIONS = [
  ...coreTools("agents", { profiles: ["coding", "messaging"], includeInOpenClawGroup: true }, [
    ["decision_evaluate"],
  ]),
  ...coreTools(
    "fs",
    { profiles: ["coding"], executionLocation: "placement", factoryFamily: "base-coding" },
    [
      ["ls", { replay: "both" }],
      ["read", { replay: "both" }],
      ["write"],
      ["edit"],
      ["apply_patch", { factoryFamily: "shell" }],
    ],
  ),
  ...coreTools("runtime", { profiles: ["coding"] }, [
    ["exec", { executionLocation: "placement", factoryFamily: "shell" }],
    ["process", { executionLocation: "placement", factoryFamily: "shell" }],
    ["code_execution", { includeInOpenClawGroup: true, factoryFamily: undefined }],
    [
      "secrets",
      {
        profiles: ["coding", "messaging"],
        includeInOpenClawGroup: true,
      },
    ],
  ]),
  ...coreTools(
    "web",
    {
      profiles: ["coding"],
      includeInOpenClawGroup: true,
      replay: "both",
    },
    [["web_search"], ["web_fetch"], ["x_search", { factoryFamily: undefined }]],
  ),
  ...coreTools(
    "memory",
    { profiles: ["coding"], includeInOpenClawGroup: true, factoryFamily: undefined },
    [
      ["memory_search"],
      ["memory_get", { replay: "both" }],
      ["personal_instructions", { profiles: ["coding", "messaging"], factoryFamily: "openclaw" }],
    ],
  ),
  ...coreTools("sessions", { profiles: ["coding", "messaging"], includeInOpenClawGroup: true }, [
    ["presence", { executionLocation: "gateway", profiles: ["minimal", "coding", "messaging"] }],
    ["sessions"],
    ["sessions_create", { factoryFamily: undefined }],
    ["sessions_list", { replay: "both" }],
    ["sessions_history", { replay: "both" }],
    ["sessions_search", { replay: "both" }],
    ["conversations_list", { replay: "both" }],
    ["conversations_send"],
    ["conversations_turn"],
    ["sessions_send", { executionLocation: "gateway" }],
    ["sessions_spawn", { executionLocation: "gateway" }],
    ["github_identity_status", { profiles: ["coding"] }],
    ["github_publish", { profiles: ["coding"] }],
    ["agents_wait", { profiles: ["coding"] }],
    ["sessions_yield"],
    ["subagents"],
    ["session_status", { profiles: ["minimal", "coding", "messaging"] }],
    ["suggest_task", { profiles: ["coding"] }],
    ["dismiss_task", { profiles: ["coding"] }],
  ]),
  ...coreTools("ui", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["browser", { executionLocation: "placement", profiles: [], factoryFamily: undefined }],
    ["screen"],
    ["theme", { profiles: ["coding", "messaging"] }],
    ["dashboard"],
    ["terminal"],
    ["portal", { executionLocation: "gateway" }],
    ["canvas", { profiles: [], includeInOpenClawGroup: false, factoryFamily: undefined }],
    ["show_widget", { profiles: [] }],
  ]),
  ...coreTools("messaging", { profiles: ["messaging"], includeInOpenClawGroup: true }, [
    ["message"],
  ]),
  ...coreTools("automation", { profiles: [], includeInOpenClawGroup: true }, [
    [AUTOMATIONS_TOOL_NAME, { profiles: ["coding"] }],
    ["gateway", { profiles: ["minimal", "coding", "messaging"] }],
    ["plugins", { profiles: ["coding"] }],
    ["openclaw"],
  ]),
  ...coreTools("nodes", { profiles: [], includeInOpenClawGroup: true }, [
    ["nodes"],
    ["computer", { executionLocation: "placement" }],
    ["mobile_ui"],
  ]),
  ...coreTools("agents", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["agents_list", { profiles: [], replay: "both" }],
    ["get_goal", { replay: "both" }],
    ["create_goal"],
    ["update_goal"],
    ["progress_card"],
    ["ask_user", { profiles: ["coding", "messaging"] }],
    ["skill_workshop", { executionLocation: "gateway" }],
    ["skills_search", { factoryFamily: undefined, replay: "blind" }],
    ["skills_read", { factoryFamily: undefined, replay: "blind" }],
  ]),
  ...coreTools("media", { profiles: ["coding"], includeInOpenClawGroup: true }, [
    ["view_image", { replay: "both" }],
    ["image_generate"],
    ["music_generate"],
    ["video_generate"],
    // Catalog visibility must not change existing media group policies.
    ["transcripts", { profiles: [], includeInSectionGroup: false, includeInOpenClawGroup: false }],
    ["tts", { profiles: [] }],
    ["pdf", { profiles: [], replay: "recorded" }],
  ]),
];

export type CoreToolId = (typeof CORE_TOOL_DEFINITIONS)[number]["id"];

const CORE_TOOL_BY_ID = new Map<string, CoreToolDefinition>(
  CORE_TOOL_DEFINITIONS.map((tool) => [tool.id, tool]),
);

// Runtime-only names have no configurable profile or catalog section.
const RUNTIME_ONLY_TOOL_FACTS = new Map<string, CoreToolFacts>([
  ...["search", "find", "grep", "glob", "tool_search", "tool_describe"].map(
    (name): [string, CoreToolFacts] => [name, { replay: "both" }],
  ),
  ["structured_output", { factoryFamily: "openclaw" }],
]);

export function resolveCoreToolFacts(toolId: string): Readonly<CoreToolFacts> | undefined {
  return CORE_TOOL_BY_ID.get(toolId) ?? RUNTIME_ONLY_TOOL_FACTS.get(toolId);
}

export type OpenClawCodingToolConstructionPlan = {
  includeBaseCodingTools: boolean;
  includeShellTools: boolean;
  includeChannelTools: boolean;
  includeOpenClawTools: boolean;
  includePluginTools: boolean;
};

const CORE_TOOL_FACTORY_DESCRIPTORS = [...CORE_TOOL_BY_ID, ...RUNTIME_ONLY_TOOL_FACTS].flatMap(
  ([name, { factoryFamily }]) => (factoryFamily ? [{ name, family: factoryFamily }] : []),
);

export function resolveCoreToolFactoryFamily(name: string): CoreToolFactoryFamily | undefined {
  return resolveCoreToolFacts(name)?.factoryFamily;
}

export function listCoreToolFactoryDescriptors(): readonly {
  name: string;
  family: CoreToolFactoryFamily;
}[] {
  return CORE_TOOL_FACTORY_DESCRIPTORS;
}

/** Coding primitives stay directly visible rather than requiring a tool-search round trip. */
export function isCoreCodingSurfaceToolName(name: string): boolean {
  const family = resolveCoreToolFactoryFamily(name);
  return family === "base-coding" || family === "shell";
}

// Keep Gateway declarations for 2026.9.8 until the next supervisor dialect.
export const CORE_WORKER_LAUNCH_TOOL_NAMES = Object.freeze(
  CORE_TOOL_DEFINITIONS.filter((tool) => tool.executionLocation).map((tool) => tool.id),
);

export function resolveCoreToolExecutionLocation(toolId: string): "placement" | "gateway" {
  return CORE_TOOL_BY_ID.get(toolId)?.executionLocation ?? "gateway";
}

function listCoreToolIdsForProfile(profile: ToolProfileId): string[] {
  return CORE_TOOL_DEFINITIONS.filter((tool) => tool.profiles.includes(profile)).map(
    (tool) => tool.id,
  );
}

const CORE_TOOL_PROFILES: Record<ToolProfileId, ToolProfilePolicy> = {
  minimal: {
    allow: listCoreToolIdsForProfile("minimal"),
  },
  coding: {
    allow: [...listCoreToolIdsForProfile("coding"), "bundle-mcp"],
  },
  messaging: {
    allow: [...listCoreToolIdsForProfile("messaging"), "bundle-mcp"],
  },
  full: {
    allow: ["*"],
  },
};

function buildCoreToolGroupMap() {
  const sectionToolMap = new Map<string, string[]>();
  for (const tool of CORE_TOOL_DEFINITIONS) {
    if (tool.includeInSectionGroup === false) {
      continue;
    }
    const groupId = `group:${tool.sectionId}`;
    const list = sectionToolMap.get(groupId) ?? [];
    list.push(tool.id);
    sectionToolMap.set(groupId, list);
  }
  const openclawTools = CORE_TOOL_DEFINITIONS.filter((tool) => tool.includeInOpenClawGroup).map(
    (tool) => tool.id,
  );
  return {
    "group:openclaw": openclawTools,
    ...Object.fromEntries(sectionToolMap.entries()),
  };
}

/** Built-in core tool groups keyed by group id. */
export const CORE_TOOL_GROUPS = buildCoreToolGroupMap();

/** Profile options shown in model/tool configuration UIs. */
export const PROFILE_OPTIONS = [
  { id: "minimal", label: "Minimal" },
  { id: "coding", label: "Coding" },
  { id: "messaging", label: "Messaging" },
  { id: "full", label: "Full" },
] as const;

/** Resolves the allow/deny policy for a built-in tool profile. */
export function resolveCoreToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  if (!profile) {
    return undefined;
  }
  // SAFETY: The lookup may miss; the allow/deny check below rejects unknown profile keys.
  const resolved = CORE_TOOL_PROFILES[profile as ToolProfileId];
  if (!resolved?.allow && !resolved?.deny) {
    return undefined;
  }
  return {
    allow: resolved.allow ? [...resolved.allow] : undefined,
    deny: resolved.deny ? [...resolved.deny] : undefined,
  };
}

/** Lists built-in profile ids that include a core tool. */
export function resolveCoreToolProfiles(toolId: string): ToolProfileId[] {
  return [...(CORE_TOOL_BY_ID.get(toolId)?.profiles ?? [])];
}

/** Returns true when a tool id is a known core tool. */
export function isKnownCoreToolId(toolId: string): boolean {
  return CORE_TOOL_BY_ID.has(toolId);
}

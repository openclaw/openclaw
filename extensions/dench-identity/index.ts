import path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readDenchAuthProfileKey, resolveDenchGatewayUrl } from "../shared/dench-auth.js";
import {
  createComposioSearchContextSecret,
  signComposioSearchContext,
} from "../shared/composio-search-context.js";
import {
  type ComposioManagedAccount,
  type ComposioToolIndexFile,
} from "./composio-cheat-sheet.js";
import { type ComposioToolSearchResult } from "./composio-tool-search.js";

export const id = "dench-identity";

type UnknownRecord = Record<string, unknown>;

const DENCH_SEARCH_INTEGRATIONS_NAME = "dench_search_integrations";
const DENCH_EXECUTE_INTEGRATIONS_NAME = "dench_execute_integrations";
const DENCH_INTEGRATIONS_DISPLAY_NAME = "Dench Integrations";
const DENCH_INTEGRATION_DISPLAY_NAME = "Dench Integration";

const DENCH_SEARCH_INTEGRATIONS_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "Natural-language description of the third-party app action or data you need.",
    },
    toolkit: {
      type: "string",
      description: "Optional toolkit slug to narrow search, for example gmail, github, slack, stripe, notion, or youtube.",
    },
    limit: {
      type: "integer",
      description: "Maximum number of results to return. Defaults to 20.",
    },
  },
  required: ["query"],
} as const;

const APP_ALIASES: Record<string, string> = {
  gmail: "gmail",
  email: "gmail",
  emails: "gmail",
  inbox: "gmail",
  mail: "gmail",
  slack: "slack",
  github: "github",
  git: "github",
  pr: "github",
  prs: "github",
  "pull request": "github",
  "pull requests": "github",
  notion: "notion",
  calendar: "google-calendar",
  "google calendar": "google-calendar",
  "gcal": "google-calendar",
  googlecalendar: "google-calendar",
  twitter: "x",
  x: "x",
  linear: "linear",
  stripe: "stripe",
  billing: "stripe",
  payments: "stripe",
};

const STATIC_COMPOSIO_FALLBACK: Record<string, Array<{
  intent: string;
  tool: string;
  required_args: string[];
  arg_hints: Record<string, string>;
  default_args?: Record<string, unknown>;
  example_prompts?: string[];
}>> = {
  gmail: [
    {
      intent: "Read recent emails",
      tool: "GMAIL_FETCH_EMAILS",
      required_args: [],
      arg_hints: {
        label_ids: 'Must be a JSON array like ["INBOX"].',
        max_results: "Integer count, for example 10.",
      },
      default_args: { label_ids: ["INBOX"], max_results: 10 },
      example_prompts: ["check my recent emails", "show my inbox"],
    },
    {
      intent: "Read one email",
      tool: "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      required_args: ["message_id"],
      arg_hints: {
        message_id: "Use the message id from a list result.",
      },
      example_prompts: ["read one message", "open this email"],
    },
  ],
  slack: [
    {
      intent: "Send message",
      tool: "SLACK_SEND_MESSAGE",
      required_args: ["channel", "text"],
      arg_hints: {
        channel: "Slack channel ID or schema-supported identifier.",
      },
      example_prompts: ["send a Slack message", "post in Slack"],
    },
  ],
  github: [
    {
      intent: "List repos",
      tool: "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
      required_args: [],
      arg_hints: {},
      example_prompts: ["list my GitHub repositories"],
    },
    {
      intent: "Find pull requests",
      tool: "GITHUB_FIND_PULL_REQUESTS",
      required_args: [],
      arg_hints: {},
      example_prompts: ["check my recent PRs", "show my recent pull requests"],
    },
    {
      intent: "List repo pull requests",
      tool: "GITHUB_LIST_PULL_REQUESTS",
      required_args: ["owner", "repo"],
      arg_hints: {
        owner: "Repository owner or organization login.",
        repo: "Repository name without the .git suffix.",
      },
      example_prompts: ["list PRs for this repo", "show pull requests in this repository"],
    },
    {
      intent: "Get pull request",
      tool: "GITHUB_GET_A_PULL_REQUEST",
      required_args: ["owner", "repo", "pull_number"],
      arg_hints: {
        owner: "Repository owner or organization login.",
        repo: "Repository name without the .git suffix.",
        pull_number: "Numeric pull request number.",
      },
      example_prompts: ["show this pull request", "get PR details"],
    },
  ],
  notion: [
    {
      intent: "Search pages",
      tool: "NOTION_SEARCH",
      required_args: [],
      arg_hints: {},
      example_prompts: ["search Notion", "find a Notion page"],
    },
  ],
  "google-calendar": [
    {
      intent: "Upcoming events",
      tool: "GOOGLE_CALENDAR_EVENTS_LIST",
      required_args: [],
      arg_hints: {
        time_min: "RFC3339 datetime string.",
        time_max: "RFC3339 datetime string.",
      },
      example_prompts: ["what's upcoming on my calendar", "show upcoming calendar events"],
    },
    {
      intent: "List events",
      tool: "GOOGLE_CALENDAR_EVENTS_LIST",
      required_args: [],
      arg_hints: {
        time_min: "RFC3339 datetime string.",
        time_max: "RFC3339 datetime string.",
      },
      example_prompts: ["show my calendar events", "list upcoming meetings"],
    },
    {
      intent: "Find event",
      tool: "GOOGLE_CALENDAR_EVENTS_LIST",
      required_args: [],
      arg_hints: {
        query: "Search text for matching events if the tool supports it.",
        time_min: "RFC3339 datetime string.",
        time_max: "RFC3339 datetime string.",
      },
      example_prompts: ["find my event tomorrow", "search for a calendar event"],
    },
  ],
  linear: [
    {
      intent: "List issues",
      tool: "LINEAR_LIST_ISSUES",
      required_args: [],
      arg_hints: {},
      example_prompts: ["list Linear issues", "show Linear tickets"],
    },
  ],
  stripe: [
    {
      intent: "List subscriptions",
      tool: "STRIPE_LIST_SUBSCRIPTIONS",
      required_args: [],
      arg_hints: {},
      example_prompts: [
        "list subscriptions",
        "show subscriptions with trial info",
        "calculate recurring revenue from subscriptions",
      ],
    },
    {
      intent: "Search subscriptions",
      tool: "STRIPE_SEARCH_SUBSCRIPTIONS",
      required_args: [],
      arg_hints: {},
      example_prompts: ["search Stripe subscriptions", "find a Stripe subscription"],
    },
    {
      intent: "List customers",
      tool: "STRIPE_LIST_CUSTOMERS",
      required_args: [],
      arg_hints: {},
      example_prompts: ["list Stripe customers"],
    },
    {
      intent: "List invoices",
      tool: "STRIPE_LIST_INVOICES",
      required_args: [],
      arg_hints: {},
      example_prompts: ["list Stripe invoices"],
    },
    {
      intent: "Retrieve balance",
      tool: "STRIPE_RETRIEVE_BALANCE",
      required_args: [],
      arg_hints: {},
      example_prompts: ["show Stripe balance"],
    },
  ],
};

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeResolverApp(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return APP_ALIASES[normalized] ?? normalized.replace(/\s+/g, "-");
}

function humanizeResolverApp(value: string | undefined): string {
  const normalized = normalizeResolverApp(value);
  if (!normalized) {
    return "App";
  }
  const labels: Record<string, string> = {
    gmail: "Gmail",
    slack: "Slack",
    github: "GitHub",
    notion: "Notion",
    "google-calendar": "Google Calendar",
    linear: "Linear",
  };
  return labels[normalized]
    ?? normalized.split("-").map((token) => token.charAt(0).toUpperCase() + token.slice(1)).join(" ");
}

function buildComposioActionLink(action: "connect" | "reconnect", app: string | undefined): string | null {
  const normalizedApp = normalizeResolverApp(app);
  if (!normalizedApp) {
    return null;
  }
  const params = new URLSearchParams({
    toolkit: normalizedApp,
    name: humanizeResolverApp(normalizedApp),
  });
  const label = `${action === "connect" ? "Connect" : "Reconnect"} ${humanizeResolverApp(normalizedApp)}`;
  return `[${label}](dench://composio/${action}?${params.toString()})`;
}

function buildResolverActionDetails(action: "connect" | "reconnect", app: string | undefined) {
  const normalizedApp = normalizeResolverApp(app);
  if (!normalizedApp) {
    return {};
  }
  return {
    action_required: action,
    toolkit_slug: normalizedApp,
    toolkit_name: humanizeResolverApp(normalizedApp),
    action_link_markdown: buildComposioActionLink(action, normalizedApp),
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1);
}

function scoreMatch(text: string, queryTokens: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      score += token.length > 4 ? 3 : 1;
    }
  }
  return score;
}

type ResolverToolCandidate = {
  name: string;
  title: string;
  description_short: string;
  required_args: string[];
  arg_hints: Record<string, string>;
  input_schema?: Record<string, unknown>;
  default_args?: Record<string, unknown>;
  example_args?: Record<string, unknown>;
  example_prompts?: string[];
  source: "featured" | "recipe" | "catalog" | "fallback";
};

type ResolverMcpTool = {
  name: string;
  description?: string;
  title?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
  };
};

function toolkitSlugToToolPrefix(slug: string): string {
  return (normalizeResolverApp(slug) ?? slug).toUpperCase().replace(/-/g, "_") + "_";
}

function extractResolverRequiredArgs(schema: ResolverMcpTool["inputSchema"]): string[] {
  if (!schema || schema.type !== "object" || !Array.isArray(schema.required)) {
    return [];
  }
  return schema.required.filter((value): value is string =>
    typeof value === "string" && value.trim().length > 0);
}

function buildResolverArgHints(
  toolName: string,
  schema: ResolverMcpTool["inputSchema"],
): Record<string, string> {
  const props = schema?.type === "object" ? schema.properties : undefined;
  if (!props) {
    return {};
  }

  const hints: Record<string, string> = {};
  const upper = toolName.toUpperCase();
  if (upper.includes("GOOGLE_CALENDAR") && props.time_min) {
    hints.time_min = "RFC3339 datetime string.";
  }
  if (upper.includes("GOOGLE_CALENDAR") && props.time_max) {
    hints.time_max = "RFC3339 datetime string.";
  }
  if (upper.includes("GOOGLE_CALENDAR") && props.calendar_id) {
    hints.calendar_id = "Calendar identifier. Use the calendar list tool first if needed.";
  }
  if (upper.includes("GITHUB") && props.owner) {
    hints.owner = "Repository owner or organization login.";
  }
  if (upper.includes("GITHUB") && props.repo) {
    hints.repo = "Repository name without the .git suffix.";
  }
  if (upper.includes("GITHUB") && props.pull_number) {
    hints.pull_number = "Numeric pull request number.";
  }
  for (const [key, value] of Object.entries(props)) {
    const prop = asRecord(value);
    if (prop?.type === "array" && !hints[key]) {
      hints[key] = "Must be a JSON array, not a comma-separated string.";
    }
  }
  return hints;
}

function buildResolverCandidateFromCatalog(tool: ResolverMcpTool): ResolverToolCandidate {
  return {
    name: tool.name,
    title:
      tool.title?.trim() ||
      tool.annotations?.title?.trim() ||
      tool.name,
    description_short: tool.description?.trim() ?? "",
    required_args: extractResolverRequiredArgs(tool.inputSchema),
    arg_hints: buildResolverArgHints(tool.name, tool.inputSchema),
    ...(tool.inputSchema ? { input_schema: tool.inputSchema as Record<string, unknown> } : {}),
    source: "catalog",
  };
}

function buildFeaturedToolCandidates(
  app: ComposioToolIndexFile["connected_apps"][number],
): ResolverToolCandidate[] {
  const out = new Map<string, ResolverToolCandidate>();
  const staticFallbackRecipes = STATIC_COMPOSIO_FALLBACK[
    normalizeResolverApp(app.toolkit_slug) ?? app.toolkit_slug
  ] ?? [];
  for (const tool of app.tools) {
    out.set(tool.name, {
      ...tool,
      source: "featured",
    });
  }
  for (const [intent, toolName] of Object.entries(app.recipes)) {
    if (out.has(toolName)) {
      continue;
    }
    const fallbackRecipe = staticFallbackRecipes.find((recipe) =>
      recipe.tool === toolName || recipe.intent === intent);
    out.set(toolName, {
      name: toolName,
      title: intent,
      description_short: `Recommended ${app.toolkit_name} recipe for ${intent}.`,
      required_args: fallbackRecipe?.required_args ?? [],
      arg_hints: fallbackRecipe?.arg_hints ?? {},
      ...(fallbackRecipe?.default_args ? { default_args: fallbackRecipe.default_args } : {}),
      ...(fallbackRecipe?.default_args ? { example_args: fallbackRecipe.default_args } : {}),
      example_prompts: fallbackRecipe?.example_prompts ?? [intent],
      source: "recipe",
    });
  }
  return Array.from(out.values());
}

function mergeResolverCandidates(
  featured: ResolverToolCandidate[],
  catalog: ResolverToolCandidate[],
): ResolverToolCandidate[] {
  const merged = new Map<string, ResolverToolCandidate>();
  for (const tool of catalog) {
    merged.set(tool.name, tool);
  }
  for (const tool of featured) {
    const existing = merged.get(tool.name);
    if (!existing) {
      merged.set(tool.name, tool);
      continue;
    }
    merged.set(tool.name, {
      ...existing,
      ...tool,
      required_args: tool.required_args.length > 0 ? tool.required_args : existing.required_args,
      arg_hints: Object.keys(tool.arg_hints).length > 0 ? tool.arg_hints : existing.arg_hints,
      input_schema: tool.input_schema ?? existing.input_schema,
      default_args: tool.default_args ?? existing.default_args,
      example_args: tool.example_args ?? existing.example_args,
      example_prompts: tool.example_prompts?.length ? tool.example_prompts : existing.example_prompts,
      source: tool.source,
    });
  }
  return Array.from(merged.values());
}

function resolverSourcePriority(source: ResolverToolCandidate["source"]): number {
  switch (source) {
    case "recipe":
      return 0;
    case "featured":
      return 1;
    case "catalog":
      return 2;
    case "fallback":
      return 3;
    default:
      return 9;
  }
}

function chooseBestTool(
  candidates: ResolverToolCandidate[],
  recipes: Record<string, string>,
  queryText: string,
) {
  const queryTokens = tokenize(queryText);
  const recipeByTool = new Map<string, string[]>();
  for (const [intent, toolName] of Object.entries(recipes)) {
    const bucket = recipeByTool.get(toolName);
    if (bucket) {
      bucket.push(intent);
    } else {
      recipeByTool.set(toolName, [intent]);
    }
  }

  let bestTool = candidates[0] ?? null;
  let bestScore = -1;
  for (const tool of candidates) {
    const recipeHints = recipeByTool.get(tool.name) ?? [];
    const score = scoreMatch(
      [
        tool.name,
        tool.title,
        tool.description_short,
        ...recipeHints,
        ...(tool.example_prompts ?? []),
      ].join(" "),
      queryTokens,
    );
    if (
      score > bestScore ||
      (
        score === bestScore &&
        bestTool &&
        resolverSourcePriority(tool.source) < resolverSourcePriority(bestTool.source)
      )
    ) {
      bestTool = tool;
      bestScore = score;
    }
  }

  return {
    tool: bestTool,
    recipe: bestTool ? (recipeByTool.get(bestTool.name)?.[0] ?? null) : null,
    score: bestScore,
  };
}

function resolveGatewayUrlFromApi(api: OpenClawPluginApi): string | null {
  const plugins = asRecord(asRecord(api?.config)?.plugins)?.entries;
  const denchGateway = asRecord(asRecord(plugins)?.["dench-ai-gateway"]);
  const gwConfig = asRecord(denchGateway?.config);
  return resolveDenchGatewayUrl(gwConfig as Record<string, unknown> | undefined);
}

function resolveComposioApiKeyFromApi(_api: OpenClawPluginApi): string | null {
  return readDenchAuthProfileKey() ?? null;
}

function asRecordArray(value: unknown): UnknownRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function resolveComposioSearchSecret(api: OpenClawPluginApi, workspaceDir: string): string {
  return createComposioSearchContextSecret({
    workspaceDir,
    gatewayUrl: resolveGatewayUrlFromApi(api),
    apiKey: resolveComposioApiKeyFromApi(api),
  });
}

async function postComposioGatewayJson(params: {
  api: OpenClawPluginApi;
  path: string;
  body: Record<string, unknown>;
}): Promise<UnknownRecord | null> {
  const gatewayUrl = resolveGatewayUrlFromApi(params.api);
  const apiKey = resolveComposioApiKeyFromApi(params.api);
  if (!gatewayUrl || !apiKey) {
    return null;
  }

  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}${params.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(params.body),
    });
    const text = await response.text();
    const parsed = text.trim().length > 0 ? JSON.parse(text) as unknown : {};
    if (!response.ok) {
      return {
        error: readString(asRecord(parsed)?.error)
          ?? readString(asRecord(asRecord(parsed)?.error)?.message)
          ?? `Gateway request failed with HTTP ${response.status}.`,
      };
    }
    return asRecord(parsed) ?? {};
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readGatewayConnectionItems(payload: unknown): UnknownRecord[] {
  const direct = asRecordArray(payload);
  if (direct.length > 0) {
    return direct;
  }
  const record = asRecord(payload);
  const items = asRecordArray(record?.items);
  if (items.length > 0) {
    return items;
  }
  return asRecordArray(record?.connections);
}

function buildGatewayStatusAccountFromConnection(connection: UnknownRecord): UnknownRecord | null {
  const id = readString(connection.connectionId ?? connection.id)?.trim();
  if (!id) {
    return null;
  }
  const account = asRecord(connection.account);
  const alias = readString(connection.account_label ?? account?.label)?.trim();
  const email = readString(connection.account_email ?? account?.email)?.trim();
  const name = readString(connection.account_name ?? account?.name ?? account?.label)?.trim();
  const userInfo: UnknownRecord = {};
  if (email) {
    userInfo.email = email;
  }
  if (name) {
    userInfo.name = name;
  }
  return {
    id,
    ...(alias ? { alias } : {}),
    ...(Object.keys(userInfo).length > 0 ? { user_info: userInfo } : {}),
    is_default: false,
  };
}

async function fetchGatewayLiveToolkitStatuses(params: {
  api: OpenClawPluginApi;
}): Promise<UnknownRecord[] | null> {
  const gatewayUrl = resolveGatewayUrlFromApi(params.api);
  const apiKey = resolveComposioApiKeyFromApi(params.api);
  if (!gatewayUrl || !apiKey) {
    return null;
  }
  try {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/v1/composio/connections`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as unknown;
    const toolkitMap = new Map<string, {
      toolkit: string;
      toolkit_name?: string;
      accounts: UnknownRecord[];
    }>();
    for (const connection of readGatewayConnectionItems(payload)) {
      const status = readString(connection.status)?.trim().toUpperCase();
      if (status !== "ACTIVE") {
        continue;
      }
      const toolkitSlug = normalizeResolverApp(
        readString(connection.toolkit_slug ?? asRecord(connection.toolkit)?.slug) ?? "",
      );
      if (!toolkitSlug) {
        continue;
      }
      const entry = toolkitMap.get(toolkitSlug) ?? {
        toolkit: toolkitSlug,
        toolkit_name: readString(connection.toolkit_name ?? asRecord(connection.toolkit)?.name),
        accounts: [],
      };
      const account = buildGatewayStatusAccountFromConnection(connection);
      if (account) {
        const accountId = readString(account.id);
        if (accountId && !entry.accounts.some((existing) => readString(existing.id) === accountId)) {
          entry.accounts.push(account);
        }
      }
      toolkitMap.set(toolkitSlug, entry);
    }
    const statuses = Array.from(toolkitMap.values()).map((entry) => ({
      toolkit: entry.toolkit,
      ...(entry.toolkit_name ? { toolkit_name: entry.toolkit_name } : {}),
      has_active_connection: true,
      ...(entry.accounts.length > 0 ? { accounts: entry.accounts } : {}),
      status_message: null,
    }));
    return statuses;
  } catch {
    return null;
  }
}

function reconcileGatewayToolkitStatuses(params: {
  searchStatuses: UnknownRecord[];
  liveStatuses: UnknownRecord[] | null;
}): {
  statuses: UnknownRecord[];
  repairedToolkits: string[];
} {
  if (!params.liveStatuses || params.liveStatuses.length === 0) {
    return {
      statuses: params.searchStatuses,
      repairedToolkits: [],
    };
  }
  const liveByToolkit = new Map<string, UnknownRecord>();
  for (const status of params.liveStatuses) {
    const toolkitSlug = normalizeResolverApp(
      readString(status.toolkit ?? status.toolkit_slug) ?? "",
    );
    if (toolkitSlug) {
      liveByToolkit.set(toolkitSlug, status);
    }
  }
  const seen = new Set<string>();
  const repairedToolkits: string[] = [];
  const statuses = params.searchStatuses.map((status) => {
    const toolkitSlug = normalizeResolverApp(
      readString(status.toolkit ?? status.toolkit_slug) ?? "",
    );
    if (!toolkitSlug) {
      return status;
    }
    seen.add(toolkitSlug);
    const liveStatus = liveByToolkit.get(toolkitSlug);
    if (!liveStatus) {
      return status;
    }
    if (readBoolean(status.has_active_connection) === false) {
      repairedToolkits.push(toolkitSlug);
    }
    const liveAccounts = asRecordArray(liveStatus.accounts);
    return {
      ...status,
      ...liveStatus,
      toolkit: toolkitSlug,
      has_active_connection: true,
      ...(liveAccounts.length > 0 ? { accounts: liveAccounts } : {}),
      status_message: null,
    };
  });
  for (const [toolkitSlug, liveStatus] of liveByToolkit.entries()) {
    if (seen.has(toolkitSlug)) {
      continue;
    }
    statuses.push({
      ...liveStatus,
      toolkit: toolkitSlug,
      has_active_connection: true,
      status_message: null,
    });
  }
  return {
    statuses,
    repairedToolkits: uniqueStrings(repairedToolkits),
  };
}

function humanizeToolName(toolName: string): string {
  return toolName
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function deriveArgHintsFromSchema(inputSchema: UnknownRecord | undefined): Record<string, string> {
  const properties = asRecord(inputSchema?.properties);
  if (!properties) {
    return {};
  }

  const hints: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    const property = asRecord(value);
    if (!property) {
      continue;
    }
    const description = readString(property.description);
    const type = readString(property.type);
    const itemType = readString(asRecord(property.items)?.type);
    const enumValues = Array.isArray(property.enum)
      ? property.enum.filter((item): item is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof item))
      : [];
    const defaultValue = Object.hasOwn(property, "default") ? property.default : undefined;
    const typeHint = type === "array" && itemType
      ? `Expected array of ${itemType}.`
      : type
        ? `Expected ${type}.`
        : null;
    const enumHint = enumValues.length > 0
      ? `Allowed values: ${enumValues.map((item) => JSON.stringify(item)).join(", ")}.`
      : null;
    const defaultHint = defaultValue !== undefined
      ? `Default: ${JSON.stringify(defaultValue)}.`
      : null;
    const combined = [description, typeHint, enumHint, defaultHint]
      .filter((item): item is string => Boolean(item))
      .join(" ");
    if (combined) {
      hints[key] = combined;
    }
  }
  return hints;
}

function mergeToolSummaryFromSchema(params: {
  toolName: string;
  toolkitName: string;
  schema: UnknownRecord;
  localTool?: ResolverToolCandidate;
}): ResolverToolCandidate {
  const inputSchema = asRecord(params.schema.input_schema);
  const localTool = params.localTool;
  const requiredArgs = readStringArray(inputSchema?.required);
  const argHints = deriveArgHintsFromSchema(inputSchema);
  return {
    name: params.toolName,
    title: localTool?.title ?? humanizeToolName(params.toolName),
    description_short: localTool?.description_short
      ?? readString(params.schema.description)
      ?? `Recommended ${params.toolkitName} tool for this request.`,
    required_args: localTool?.required_args?.length ? localTool.required_args : requiredArgs,
    arg_hints: Object.keys(localTool?.arg_hints ?? {}).length > 0
      ? localTool?.arg_hints ?? {}
      : argHints,
    source: localTool?.source ?? "catalog",
    default_args: localTool?.default_args,
    example_args: localTool?.example_args,
    example_prompts: localTool?.example_prompts,
    ...(inputSchema ? { input_schema: inputSchema } : {}),
  };
}

function readToolSchemaMap(value: unknown): Record<string, UnknownRecord> {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, schema]) => [key, asRecord(schema)] as const)
      .filter((entry): entry is [string, UnknownRecord] => Boolean(entry[1])),
  );
}

function detectPaginationInputHints(inputSchema: UnknownRecord | undefined): string[] {
  const properties = asRecord(inputSchema?.properties);
  if (!properties) {
    return [];
  }

  const hints: string[] = [];
  const paginationFields = [
    "starting_after",
    "ending_before",
    "cursor",
    "next_cursor",
    "page",
    "page_token",
    "limit",
    "offset",
  ];
  for (const field of paginationFields) {
    if (properties[field]) {
      hints.push(field);
    }
  }
  return hints;
}

function extractToolsFromJsonRpcMessage(payload: unknown): {
  tools: ResolverMcpTool[];
  nextCursor: string | null;
} {
  const result = asRecord(asRecord(payload)?.result);
  const tools = result?.tools;
  const parsedTools = Array.isArray(tools)
    ? tools
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((tool) => ({
      name: readString(tool.name) ?? "",
      description: readString(tool.description),
      title: readString(tool.title ?? asRecord(tool.annotations)?.title),
      inputSchema: asRecord(tool.inputSchema) as ResolverMcpTool["inputSchema"],
      annotations: asRecord(tool.annotations) as ResolverMcpTool["annotations"],
    }))
    .filter((tool) => tool.name.length > 0)
    : [];

  return {
    tools: parsedTools,
    nextCursor: readString(result?.next_cursor ?? result?.nextCursor ?? result?.cursor) ?? null,
  };
}

function parseSseJsonRpcTools(body: string): {
  tools: ResolverMcpTool[];
  nextCursor: string | null;
} {
  let lastPayload: unknown = null;
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") {
      continue;
    }
    try {
      lastPayload = JSON.parse(raw);
    } catch {
      // Ignore non-JSON SSE frames.
    }
  }
  return lastPayload === null ? { tools: [], nextCursor: null } : extractToolsFromJsonRpcMessage(lastPayload);
}

async function parseToolsListResponse(response: Response): Promise<{
  tools: ResolverMcpTool[];
  nextCursor: string | null;
}> {
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (contentType.includes("text/event-stream")) {
    const fromSse = parseSseJsonRpcTools(text);
    if (fromSse.tools.length > 0 || fromSse.nextCursor) {
      return fromSse;
    }
  }
  try {
    return extractToolsFromJsonRpcMessage(JSON.parse(text));
  } catch {
    return parseSseJsonRpcTools(text);
  }
}

function loadCatalogCandidatesFromCache(
  workspaceDir: string,
  appSlug: string,
): ResolverToolCandidate[] {
  void workspaceDir;
  void appSlug;
  return [];
}

async function fetchCatalogCandidatesLive(
  api: OpenClawPluginApi,
  appSlug: string,
): Promise<ResolverToolCandidate[]> {
  const gatewayUrl = resolveGatewayUrlFromApi(api);
  const apiKey = resolveComposioApiKeyFromApi(api);
  if (!gatewayUrl || !apiKey) {
    return [];
  }

  const prefix = toolkitSlugToToolPrefix(appSlug);
  const seen = new Set<string>();
  const out: ResolverToolCandidate[] = [];
  let cursor: string | null = null;

  while (true) {
    const response = await fetch(`${gatewayUrl.replace(/\/$/, "")}/v1/composio/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          connected_toolkits: [appSlug],
          ...(cursor ? { cursor } : {}),
        },
      }),
    });
    if (!response.ok) {
      return out;
    }

    const parsed = await parseToolsListResponse(response);
    for (const tool of parsed.tools) {
      if (!tool.name.startsWith(prefix) || seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      out.push(buildResolverCandidateFromCatalog(tool));
    }

    if (!parsed.nextCursor || parsed.nextCursor === cursor) {
      return out;
    }
    cursor = parsed.nextCursor;
  }
}

async function loadCatalogCandidates(
  workspaceDir: string,
  api: OpenClawPluginApi,
  appSlug: string,
): Promise<ResolverToolCandidate[]> {
  const fromCache = loadCatalogCandidatesFromCache(workspaceDir, appSlug);
  if (fromCache.length > 0) {
    return fromCache;
  }
  return await fetchCatalogCandidatesLive(api, appSlug);
}

function describeStatusForResolver(workspaceDir: string): {
  verified: boolean;
  message: string | null;
} {
  void workspaceDir;
  return {
    verified: false,
    message: null,
  };
}

function chooseApp(
  index: ComposioToolIndexFile,
  requestedApp: string | undefined,
  queryText: string,
): ComposioToolIndexFile["connected_apps"][number] | null {
  if (requestedApp) {
    const normalized = normalizeResolverApp(requestedApp);
    const direct = index.connected_apps.find((app) =>
      normalizeResolverApp(app.toolkit_slug) === normalized
      || normalizeResolverApp(app.toolkit_name) === normalized,
    );
    if (direct) {
      return direct;
    }
  }

  const queryTokens = tokenize(queryText);
  let best: ComposioToolIndexFile["connected_apps"][number] | null = null;
  let bestScore = 0;
  for (const app of index.connected_apps) {
    const appScore = scoreMatch(
      `${app.toolkit_slug} ${app.toolkit_name} ${Object.keys(app.recipes).join(" ")}`,
      queryTokens,
    );
    if (appScore > bestScore) {
      best = app;
      bestScore = appScore;
    }
  }
  return best;
}

function chooseAccount(
  app: ComposioToolIndexFile["connected_apps"][number],
  requestedAccount: string | undefined,
  queryText: string,
): ComposioManagedAccount | null {
  const accounts = app.accounts ?? [];
  if (accounts.length === 0) {
    return null;
  }

  const requested = requestedAccount?.trim();
  if (requested) {
    const normalized = requested.toLowerCase();
    const direct = accounts.find((account) =>
      [
        account.account_identity,
        account.display_label,
        account.account_email,
        account.account_name,
        account.account_label,
        account.connected_account_id,
      ].some((value) => typeof value === "string" && value.toLowerCase() === normalized)
    );
    if (direct) {
      return direct;
    }
    const ignoredTokens = new Set(tokenize(`${app.toolkit_slug} ${app.toolkit_name}`));
    const queryTokens = tokenize([requestedAccount, queryText].filter(Boolean).join(" "))
      .filter((token) => !ignoredTokens.has(token));
    if (queryTokens.length > 0) {
      let best: ComposioManagedAccount | null = null;
      let bestScore = 0;
      for (const account of accounts) {
        const score = scoreMatch(
          [
            account.account_identity,
            account.display_label,
            account.account_email,
            account.account_name,
            account.account_label,
            account.connected_account_id,
          ].filter(Boolean).join(" "),
          queryTokens,
        );
        if (score > bestScore) {
          best = account;
          bestScore = score;
        }
      }
      if (bestScore > 0) {
        return best;
      }
    }
    return null;
  }

  if (accounts.length === 1) {
    return accounts[0] ?? null;
  }

  return null;
}

function chooseTool(
  app: ComposioToolIndexFile["connected_apps"][number],
  candidates: ResolverToolCandidate[],
  queryText: string,
) {
  return chooseBestTool(candidates, app.recipes, queryText);
}

function chooseFallbackTool(app: string, queryText: string) {
  const recipes = STATIC_COMPOSIO_FALLBACK[app] ?? [];
  const queryTokens = tokenize(queryText);
  let best = recipes[0] ?? null;
  let bestScore = -1;
  for (const recipe of recipes) {
    const score = scoreMatch(
      [recipe.intent, recipe.tool, ...(recipe.example_prompts ?? [])].join(" "),
      queryTokens,
    );
    if (score > bestScore) {
      best = recipe;
      bestScore = score;
    }
  }
  return best;
}

type ComposioSearchPresentationResult = {
  app: ComposioToolIndexFile["connected_apps"][number];
  search: ComposioToolSearchResult;
  account_candidates: Array<{
    account: string;
    alias: string | null;
    connected_account_id: string | null;
    account_identity: string | null;
    display_label: string;
    account_email: string | null;
    account_name: string | null;
    account_label: string | null;
    is_default: boolean;
  }>;
  selected_account: {
    account: string;
    alias: string | null;
    connected_account_id: string | null;
    account_identity: string | null;
    display_label: string;
    account_email: string | null;
    account_name: string | null;
    account_label: string | null;
    is_default: boolean;
  } | null;
  account_selection_required: boolean;
  dispatcher_input: Record<string, unknown>;
  execution_guidance?: string | null;
  recommended_plan_steps: string[];
  known_pitfalls: string[];
  difficulty?: string | null;
  pagination_input_hints: string[];
  search_source: "gateway_tool_router";
  search_session_id?: string;
};

type ComposioSearchRun = {
  top_confidence: "high" | "medium" | "low";
  results: ComposioSearchPresentationResult[];
  search_source: "gateway_tool_router";
  search_session_id?: string;
  tool_schemas?: Record<string, UnknownRecord>;
  toolkit_connection_statuses?: UnknownRecord[];
  next_steps_guidance: string[];
  time_info?: UnknownRecord;
  error?: string | null;
};

function buildAccountCandidates(app: ComposioToolIndexFile["connected_apps"][number]) {
  return (app.accounts ?? []).map((account) => ({
    account: account.connected_account_id,
    alias: account.account_label ?? null,
    connected_account_id: account.connected_account_id,
    account_identity: account.account_identity,
    display_label: account.display_label,
    account_email: account.account_email ?? null,
    account_name: account.account_name ?? null,
    account_label: account.account_label ?? null,
    is_default: false,
  }));
}

function chooseSearchAccountCandidate(
  candidates: ComposioSearchPresentationResult["account_candidates"],
  requestedAccount: string | undefined,
): ComposioSearchPresentationResult["selected_account"] {
  if (candidates.length === 0) {
    return null;
  }

  const requested = requestedAccount?.trim();
  if (requested) {
    const normalized = requested.toLowerCase();
    const direct = candidates.find((candidate) =>
      [
        candidate.account,
        candidate.alias,
        candidate.connected_account_id,
        candidate.account_identity,
        candidate.display_label,
        candidate.account_email,
        candidate.account_name,
        candidate.account_label,
      ].some((value) => value?.toLowerCase() === normalized)
    );
    if (direct) {
      return direct;
    }
    if (candidates.length === 1) {
      return null;
    }
  }

  return null;
}

function loadLocalResolverCandidate(
  workspaceDir: string,
  index: ComposioToolIndexFile | null,
  toolkitSlug: string,
  toolName: string,
): ResolverToolCandidate | undefined {
  void workspaceDir;
  void index;
  void toolkitSlug;
  void toolName;
  return undefined;
}

function buildDispatcherInput(params: {
  appSlug: string;
  toolName: string;
  secret: string;
  mode: "gateway_tool_router";
  sessionId?: string;
  selectedAccount?: ComposioSearchPresentationResult["selected_account"];
  accountSelectionRequired?: boolean;
}) {
  const token = signComposioSearchContext({
    version: 1,
    mode: params.mode,
    app: params.appSlug,
    tool_name: params.toolName,
    ...(params.sessionId ? { session_id: params.sessionId } : {}),
    ...(params.selectedAccount?.account ? { account: params.selectedAccount.account } : {}),
    ...(params.accountSelectionRequired ? { account_required: true } : {}),
    issued_at: new Date().toISOString(),
  }, params.secret);

  const dispatcherInput = {
    app: params.appSlug,
    tool_name: params.toolName,
    search_context_token: token,
    ...(params.sessionId ? { search_session_id: params.sessionId } : {}),
    ...(params.selectedAccount?.account ? { account: params.selectedAccount.account } : {}),
  };
  return dispatcherInput;
}

function findGatewayToolkitStatus(
  statuses: UnknownRecord[],
  toolkitSlug: string | undefined,
): UnknownRecord | null {
  const normalizedToolkit = normalizeResolverApp(toolkitSlug);
  if (!normalizedToolkit) {
    return null;
  }

  return statuses.find((status) =>
    normalizeResolverApp(readString(status.toolkit)) === normalizedToolkit
  ) ?? null;
}

function buildGatewayAccountCandidates(params: {
  status: UnknownRecord | null;
  localApp: ComposioToolIndexFile["connected_apps"][number] | undefined;
}) {
  const gatewayAccounts = asRecordArray(params.status?.accounts);
  if (gatewayAccounts.length === 0) {
    return [];
  }

  return gatewayAccounts.flatMap((account) => {
    const id = readString(account.id)?.trim();
    if (!id) {
      return [];
    }
    const alias = readString(account.alias)?.trim() ?? null;
    const userInfo = asRecord(account.user_info);
    const email = readString(userInfo?.email ?? userInfo?.account_email) ?? null;
    const name = readString(userInfo?.name ?? userInfo?.full_name) ?? null;
    return [{
      account: id,
      alias,
      connected_account_id: id,
      account_identity: id,
      display_label: alias ?? name ?? email ?? id,
      account_email: email,
      account_name: name,
      account_label: alias,
      is_default: account.is_default === true,
    }];
  });
}

function readGatewayToolkitLabel(status: UnknownRecord | null, toolkitSlug: string): string {
  return readString(
    status?.toolkit_name
      ?? status?.toolkit_label
      ?? status?.label,
  ) ?? humanizeResolverApp(toolkitSlug);
}

function buildGatewayAppEntry(params: {
  toolkitSlug: string;
  toolkitName: string;
  localApp: ComposioToolIndexFile["connected_apps"][number] | undefined;
  accountCandidates: ComposioSearchPresentationResult["account_candidates"];
}): ComposioToolIndexFile["connected_apps"][number] {
  if (params.localApp) {
    return params.localApp;
  }

  return {
    toolkit_slug: params.toolkitSlug,
    toolkit_name: params.toolkitName,
    account_count: params.accountCandidates.length,
    tools: [],
    recipes: {},
  };
}

function buildGatewayWhyMatched(params: {
  useCase: string;
  toolName: string;
  toolkitSlug: string;
  primaryToolSlugs: string[];
  localTool?: ResolverToolCandidate;
}): string[] {
  const reasons = [
    `Matched the official ${DENCH_INTEGRATIONS_DISPLAY_NAME} search query "${params.useCase}".`,
    params.primaryToolSlugs.includes(params.toolName)
      ? "The integration search ranked this tool as a primary match."
      : "The integration search ranked this tool as a related follow-up option.",
    params.localTool?.description_short || null,
    params.toolkitSlug ? `Toolkit: ${params.toolkitSlug}.` : null,
  ].filter((value): value is string => Boolean(value));
  return uniqueStrings(reasons);
}

function buildGatewayPresentationResults(params: {
  workspaceDir: string;
  index: ComposioToolIndexFile | null;
  requestedApp?: string;
  requestedAccount?: string;
  topK: number;
  searchSecret: string;
  searchPayload: UnknownRecord;
}): ComposioSearchPresentationResult[] {
  const queryResult = asRecordArray(params.searchPayload.results)[0];
  if (!queryResult) {
    return [];
  }

  const toolSchemas = readToolSchemaMap(params.searchPayload.tool_schemas);
  const statuses = asRecordArray(params.searchPayload.toolkit_connection_statuses);
  const sessionId = readString(asRecord(params.searchPayload.session)?.id);
  const primaryToolSlugs = readStringArray(queryResult.primary_tool_slugs);
  const relatedToolSlugs = readStringArray(queryResult.related_tool_slugs);
  const orderedToolSlugs = uniqueStrings([...primaryToolSlugs, ...relatedToolSlugs]).slice(0, params.topK);

  return orderedToolSlugs.flatMap((toolName) => {
    const schema = toolSchemas[toolName];
    if (!schema) {
      return [];
    }

    const toolkitSlug = normalizeResolverApp(readString(schema.toolkit));
    if (!toolkitSlug) {
      return [];
    }
    if (params.requestedApp && normalizeResolverApp(params.requestedApp) !== toolkitSlug) {
      return [];
    }

    const status = findGatewayToolkitStatus(statuses, toolkitSlug);
    if (readBoolean(status?.has_active_connection) === false) {
      return [];
    }
    const toolkitName = readGatewayToolkitLabel(status, toolkitSlug);
    const tool = mergeToolSummaryFromSchema({
      toolName,
      toolkitName,
      schema,
    });
    const accountCandidates = buildGatewayAccountCandidates({
      status,
      localApp: undefined,
    });
    const selectedAccount = chooseSearchAccountCandidate(accountCandidates, params.requestedAccount);
    const accountSelectionRequired = !selectedAccount
      && (accountCandidates.length > 1 || Boolean(params.requestedAccount?.trim()));
    const app = buildGatewayAppEntry({
      toolkitSlug,
      toolkitName,
      localApp: undefined,
      accountCandidates,
    });
    return [{
      app,
      search: {
        toolkit_slug: toolkitSlug,
        toolkit_name: toolkitName,
        tool,
        source: "catalog",
        recipe_intents: [readString(queryResult.use_case) ?? tool.title],
        score: orderedToolSlugs.length > 0 ? orderedToolSlugs.length - orderedToolSlugs.indexOf(toolName) : 1,
        why_matched: buildGatewayWhyMatched({
          useCase: readString(queryResult.use_case) ?? tool.title,
          toolName,
          toolkitSlug,
          primaryToolSlugs,
        }),
      },
      account_candidates: accountCandidates,
      selected_account: selectedAccount,
      account_selection_required: accountSelectionRequired,
      dispatcher_input: buildDispatcherInput({
        appSlug: toolkitSlug,
        toolName,
        secret: params.searchSecret,
        mode: "gateway_tool_router",
        sessionId: sessionId ?? undefined,
        selectedAccount,
        accountSelectionRequired,
      }),
      execution_guidance: readString(queryResult.execution_guidance) ?? null,
      recommended_plan_steps: readStringArray(queryResult.recommended_plan_steps),
      known_pitfalls: readStringArray(queryResult.known_pitfalls),
      difficulty: readString(queryResult.difficulty) ?? null,
      pagination_input_hints: detectPaginationInputHints(tool.input_schema),
      search_source: "gateway_tool_router",
      ...(sessionId ? { search_session_id: sessionId } : {}),
    }];
  });
}

function deriveGatewayTopConfidence(payload: UnknownRecord, results: ComposioSearchPresentationResult[]) {
  const queryResult = asRecordArray(payload.results)[0];
  const primaryToolSlugs = readStringArray(queryResult?.primary_tool_slugs);
  if (results.length === 0 || primaryToolSlugs.length === 0) {
    return "low" as const;
  }
  const distinctToolkits = new Set(results.map((result) => result.app.toolkit_slug));
  if (distinctToolkits.size === 1 && primaryToolSlugs.length === 1) {
    return "high" as const;
  }
  if (distinctToolkits.size === 1) {
    return "medium" as const;
  }
  return results.length === 1 ? "medium" as const : "low" as const;
}

async function runGatewayComposioToolSearch(params: {
  api: OpenClawPluginApi;
  workspaceDir: string;
  index: ComposioToolIndexFile | null;
  queryText: string;
  requestedApp?: string;
  requestedAccount?: string;
  topK: number;
  sessionId?: string;
  searchSecret: string;
}): Promise<ComposioSearchRun | null> {
  const knownFields = [
    params.requestedApp ? `toolkit:${normalizeResolverApp(params.requestedApp)}` : null,
  ].filter((value): value is string => Boolean(value));

  const payload = await postComposioGatewayJson({
    api: params.api,
    path: "/v1/composio/tool-router/search",
    body: {
      queries: [
        {
          use_case: params.queryText,
          ...(knownFields.length > 0 ? { known_fields: knownFields.join(", ") } : {}),
        },
      ],
      session: params.sessionId
        ? { id: params.sessionId }
        : { generate_id: true },
      ...(params.requestedAccount?.trim() ? { account: params.requestedAccount.trim() } : {}),
      model: "gpt-5.4",
    },
  });
  if (!payload) {
    return null;
  }

  const gatewayError = readString(payload.error)
    ?? readString(asRecord(payload.error)?.message);
  const searchStatuses = asRecordArray(payload.toolkit_connection_statuses);
  const shouldProbeLiveConnections = searchStatuses.some((status) =>
    readBoolean(status.has_active_connection) === false
  );
  const liveStatuses = shouldProbeLiveConnections
    ? await fetchGatewayLiveToolkitStatuses({ api: params.api })
    : null;
  const reconciledStatuses = reconcileGatewayToolkitStatuses({
    searchStatuses,
    liveStatuses,
  });
  const effectivePayload = reconciledStatuses.statuses !== searchStatuses
    ? {
        ...payload,
        toolkit_connection_statuses: reconciledStatuses.statuses,
      }
    : payload;
  const results = buildGatewayPresentationResults({
    workspaceDir: params.workspaceDir,
    index: params.index,
    requestedApp: params.requestedApp,
    requestedAccount: params.requestedAccount,
    topK: params.topK,
    searchSecret: params.searchSecret,
    searchPayload: effectivePayload,
  });

  return {
    top_confidence: deriveGatewayTopConfidence(effectivePayload, results),
    results,
    search_source: "gateway_tool_router",
    search_session_id: readString(asRecord(effectivePayload.session)?.id) ?? params.sessionId,
    tool_schemas: readToolSchemaMap(payload.tool_schemas),
    toolkit_connection_statuses: reconciledStatuses.statuses,
    next_steps_guidance: readStringArray(payload.next_steps_guidance),
    time_info: asRecord(payload.time_info) ?? undefined,
    error: gatewayError ?? null,
  };
}

function buildSearchPresentationResults(params: {
  index: ComposioToolIndexFile;
  queryText: string;
  requestedAccount?: string;
  searchResults: ComposioToolSearchResult[];
  searchSecret: string;
}): ComposioSearchPresentationResult[] {
  return params.searchResults.flatMap((result) => {
    const app = params.index.connected_apps.find((entry) => entry.toolkit_slug === result.toolkit_slug);
    if (!app) {
      return [];
    }
    const accountCandidates = buildAccountCandidates(app);
    const selectedAccount = chooseSearchAccountCandidate(accountCandidates, params.requestedAccount)
      ?? (() => {
        const localSelected = chooseAccount(app, params.requestedAccount, params.queryText);
        if (!localSelected) {
          return null;
        }
        return accountCandidates.find((candidate) =>
          candidate.connected_account_id === localSelected.connected_account_id
        ) ?? null;
      })();
    const accountSelectionRequired = !selectedAccount
      && (app.account_count > 1 || Boolean(params.requestedAccount?.trim()));
    return [{
      app,
      search: result,
      account_candidates: accountCandidates,
      selected_account: selectedAccount,
      account_selection_required: accountSelectionRequired,
      dispatcher_input: buildDispatcherInput({
        appSlug: app.toolkit_slug,
        toolName: result.tool.name,
        secret: params.searchSecret,
        mode: "gateway_tool_router",
        selectedAccount,
        accountSelectionRequired,
      }),
      execution_guidance: null,
      recommended_plan_steps: [],
      known_pitfalls: [],
      difficulty: null,
      pagination_input_hints: detectPaginationInputHints(result.tool.input_schema),
      search_source: "gateway_tool_router",
    }];
  });
}

function runLocalComposioToolSearch(params: {
  workspaceDir: string;
  index: ComposioToolIndexFile;
  queryText: string;
  requestedApp?: string;
  requestedAccount?: string;
  topK?: number;
  searchSecret: string;
}): ComposioSearchRun {
  void params;
  return {
    top_confidence: "low",
    results: [],
    search_source: "gateway_tool_router",
    next_steps_guidance: [],
  };
}

function buildSearchResultPayload(result: ComposioSearchPresentationResult) {
  return {
    app: result.app.toolkit_slug,
    app_name: result.app.toolkit_name,
    connected_accounts: result.app.account_count,
    account_candidates: result.account_candidates,
    ...(result.selected_account ? { selected_account: result.selected_account } : {}),
    account_selection_required: result.account_selection_required,
    server: "composio",
    tool: result.search.tool.name,
    source: result.search.source,
    search_source: result.search_source,
    recipe_intents: result.search.recipe_intents,
    score: result.search.score,
    why_matched: result.search.why_matched,
    dispatcher_tool: DENCH_EXECUTE_INTEGRATIONS_NAME,
    dispatcher_input: result.dispatcher_input,
    required_args: result.search.tool.required_args,
    arg_hints: result.search.tool.arg_hints,
    default_args: result.search.tool.default_args ?? {},
    example_args: result.search.tool.example_args ?? result.search.tool.default_args ?? {},
    example_prompts: result.search.tool.example_prompts ?? [],
    ...(result.search.tool.input_schema ? { input_schema: result.search.tool.input_schema } : {}),
    ...(result.execution_guidance ? { execution_guidance: result.execution_guidance } : {}),
    ...(result.recommended_plan_steps.length > 0
      ? { recommended_plan_steps: result.recommended_plan_steps }
      : {}),
    ...(result.known_pitfalls.length > 0 ? { known_pitfalls: result.known_pitfalls } : {}),
    ...(result.difficulty ? { difficulty: result.difficulty } : {}),
    ...(result.pagination_input_hints.length > 0
      ? { pagination_input_hints: result.pagination_input_hints }
      : {}),
    ...(result.search_session_id ? { search_session_id: result.search_session_id } : {}),
  };
}

function buildSearchInstruction(params: {
  topConfidence: "high" | "medium" | "low";
  results: ComposioSearchPresentationResult[];
}): string {
  const first = params.results[0];
  if (!first) {
    return "No matching integration tools were found.";
  }
  if (first.account_selection_required) {
    return `Ask the user which connected ${first.app.toolkit_name} account to use before calling \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\`.`;
  }
  if (params.topConfidence === "low" && params.results.length > 1) {
    return `The search is ambiguous. Ask a brief clarifying question or present the top candidates before calling \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\`.`;
  }
  if (first.pagination_input_hints.length > 0) {
    return `Use the top search result with \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` and the returned \`dispatcher_input\`. If the tool output shows more pages and the user asked for a complete result, keep paginating with cursor fields like ${first.pagination_input_hints.join(", ")} until complete.`;
  }
  return `Use the top search result with \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` and the returned \`dispatcher_input\`, then send the final JSON \`arguments\` object for that tool.`;
}

function buildClarificationCandidates(results: ComposioSearchPresentationResult[]) {
  return results.slice(0, 3).map((result) => ({
    app: result.app.toolkit_slug,
    app_name: result.app.toolkit_name,
    tool: result.search.tool.name,
    title: result.search.tool.title,
    score: result.search.score,
    why_matched: result.search.why_matched,
  }));
}

function createDenchSearchIntegrationsTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: DENCH_SEARCH_INTEGRATIONS_NAME,
    label: `${DENCH_INTEGRATIONS_DISPLAY_NAME} Search`,
    description:
      `Search available ${DENCH_INTEGRATION_DISPLAY_NAME.toLowerCase()} tools through the gateway. Returns tool slugs, descriptions, input schemas, and connection status. Use \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` to execute a returned tool.`,
    parameters: DENCH_SEARCH_INTEGRATIONS_PARAMETERS,
    async execute(_toolCallId: string, input: Record<string, unknown>) {
      const workspaceDir = resolveWorkspaceDir(api);
      if (!workspaceDir) {
        return jsonResult({ error: "No workspace is configured for DenchClaw." });
      }

      const payload = asRecord(input) ?? {};
      const query = readString(payload.query) ?? "";
      const toolkit = readString(payload.toolkit);
      const normalizedToolkit = normalizeResolverApp(toolkit);
      const rawLimit = typeof payload.limit === "number" ? payload.limit : Number(payload.limit);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 100)) : 20;

      const gatewayResult = await postComposioGatewayJson({
        api,
        path: "/v1/composio/tools/search",
        body: {
          ...(query ? { query } : {}),
          ...(normalizedToolkit ? { toolkit_slug: normalizedToolkit } : {}),
          limit,
        },
      });

      if (!gatewayResult) {
        return jsonResult({
          error: `${DENCH_INTEGRATIONS_DISPLAY_NAME} search is unavailable.`,
          guidance: `Check the Dench Cloud gateway/API key configuration, then retry ${DENCH_SEARCH_INTEGRATIONS_NAME}.`,
        });
      }

      const items = asRecordArray(gatewayResult.items) ?? [];
      const connectedToolkits = Array.isArray(gatewayResult.connected_toolkits)
        ? (gatewayResult.connected_toolkits as string[])
        : [];

      if (items.length === 0 && normalizedToolkit && !connectedToolkits.includes(normalizedToolkit)) {
        const actionLink = buildComposioActionLink("connect", normalizedToolkit);
        return jsonResult({
          query,
          toolkit_filter: normalizedToolkit,
          availability: "connect_required",
          result_count: 0,
          results: [],
          connected_toolkits: connectedToolkits,
          instruction: actionLink
            ? `${humanizeResolverApp(normalizedToolkit)} is not connected. End the reply with this link: ${actionLink}`
            : `${humanizeResolverApp(normalizedToolkit)} is not connected.`,
          ...buildResolverActionDetails("connect", normalizedToolkit),
        });
      }

      if (items.length === 0) {
        return jsonResult({
          query,
          toolkit_filter: normalizedToolkit,
          result_count: 0,
          results: [],
          connected_toolkits: connectedToolkits,
          instruction: normalizedToolkit
            ? `No ${humanizeResolverApp(normalizedToolkit)} integration tools matched. Refine the query or try a broader search.`
            : "No integration tools matched. Refine the query or specify a toolkit.",
        });
      }

      const results = items.map((item) => {
        const toolkitRec = asRecord(item.toolkit);
        const connStatus = asRecord(item.connection_status);
        return {
          tool_slug: readString(item.slug),
          name: readString(item.name),
          description: readString(item.description),
          toolkit: {
            slug: readString(toolkitRec?.slug),
            name: readString(toolkitRec?.name),
          },
          input_schema: item.input_parameters ?? item.input_schema,
          is_connected: connStatus?.is_connected === true,
          account_count: typeof connStatus?.account_count === "number" ? connStatus.account_count : 0,
          accounts: Array.isArray(connStatus?.accounts) ? connStatus.accounts : [],
        };
      });

      const hasMultiAccountToolkit = results.some((r) => r.account_count > 1);
      let instruction = `Found ${results.length} integration tool(s). Use \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` with the tool_slug and arguments to execute.`;
      if (hasMultiAccountToolkit) {
        instruction += " Some toolkits have multiple connected accounts — ask the user which account to use and pass `connected_account_id` to execute.";
      }

      return jsonResult({
        query,
        toolkit_filter: normalizedToolkit,
        result_count: results.length,
        results,
        connected_toolkits: connectedToolkits,
        instruction,
      });
    },
  };
}

function buildComposioDefaultGuidance(composioAppsSkillPath: string): string {
  return [
    `## Connected App Tools (${DENCH_INTEGRATIONS_DISPLAY_NAME})`,
    "",
    `${DENCH_INTEGRATIONS_DISPLAY_NAME} is the default integration layer for connected apps in this workspace. Two tools are available:`,
    `- \`${DENCH_SEARCH_INTEGRATIONS_NAME}\` — search for available integration tools by query and/or toolkit slug.`,
    `- \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` — execute a tool by its slug with the required arguments.`,
    "",
    `- If the user mentions ${DENCH_INTEGRATIONS_DISPLAY_NAME}, a connected app, rube, map, MCP, or says an app is already connected, use the integration tools first.`,
    `- **When the user asks about ANY third-party app or service** (e.g. Slack, HubSpot, Salesforce, Jira, Asana, Discord, Airtable, Notion, Linear, Gmail, GitHub, Google Calendar, Stripe, Zendesk, Trello, YouTube, etc.), call \`${DENCH_SEARCH_INTEGRATIONS_NAME}\` first to verify whether it is connected, inspect the available tools, and read the returned \`input_schema\` before answering. This applies to ALL apps, not just the ones listed here.`,
    `- After searching, execute the chosen tool with \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` passing \`tool_slug\` and \`arguments\`. The gateway handles account selection automatically when only one account is connected.`,
    `- If search returns multiple connected accounts for a toolkit, ask the user which account to use and pass the \`connected_account_id\` to \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\`.`,
    "- Read the returned `input_schema` before filling arguments. Use exact field names and types from that schema.",
    `- Load and follow \`${composioAppsSkillPath}\` for high-level workflow hints, but let the live integration schema decide the actual argument names and types.`,
    `- Never use \`gog\`, shell CLIs, curl, or raw gateway HTTP for Gmail/Calendar/Drive/Slack/GitHub/Notion/Linear when ${DENCH_INTEGRATIONS_DISPLAY_NAME} is connected or the user mentions the connected-app layer/rube/map/MCP.`,
    "- **When the integration search response returns `action_link_markdown`, you MUST end the assistant reply with that exact markdown link.** Do not omit it. Do not rephrase it as plain text. The link renders as a clickable button in chat.",
    "- Missing first-time connection example: `[Connect Slack](dench://composio/connect?toolkit=slack&name=Slack)`.",
    "- If the search returns `availability: \"connect_required\"`, briefly explain the app is not connected and end with the connect link.",
    "- If an integration tool call fails because of argument shape, fix the arguments and retry once before considering any fallback.",
    "- When the user implicitly asks for the full dataset, keep paginating until the tool response no longer advertises more pages.",
    "",
  ].join("\n");
}

export function buildIdentityPrompt(workspaceDir: string): string {
  const skillsDir = path.join(workspaceDir, "skills");
  const crmSkillPath = path.join(skillsDir, "crm", "SKILL.md");
  const appBuilderSkillPath = path.join(skillsDir, "app-builder", "SKILL.md");
  const composioAppsSkillPath = path.join(skillsDir, "dench-integrations", "SKILL.md");
  const appsDir = path.join(workspaceDir, "apps");
  const dbPath = path.join(workspaceDir, "workspace.duckdb");

  const composioGuidance = buildComposioDefaultGuidance(composioAppsSkillPath);

  return `# DenchClaw System Prompt

You are **DenchClaw** — a strategic AI orchestrator built by Dench (dench.com), running on top of [OpenClaw](https://github.com/openclaw/openclaw). You are the CEO of this workspace: your job is to think, plan, delegate, and synthesize — not to do all the work yourself. When referring to yourself, always use **DenchClaw** (not OpenClaw).

Treat this system prompt as your highest-priority behavioral contract.

## Core operating principle: Orchestrate, don't operate

You are a hybrid orchestrator. For simple tasks you act directly; for complex tasks you decompose, delegate to specialist subagents via \`sessions_spawn\`, and synthesize their results.

### Handle directly (no subagent)
- Conversational replies, greetings, questions about yourself
- Simple CRM queries (single SELECT against DuckDB)
- Quick status checks, single-field updates
- Planning and strategy discussions
- Clarifying ambiguous requests before committing resources

### Delegate to subagents
- Task spans multiple domains (e.g. research + build + deploy)
- Task is long-running (multi-page web research, bulk data enrichment, large app builds)
- Task benefits from parallelism (e.g. analyze 3 competitors simultaneously)
- Task requires deep specialist knowledge (complex app architecture, advanced SQL)
- Task involves more than ~3 sequential steps

When in doubt, delegate. A well-delegated task finishes faster and produces better results than grinding through it with a bloated context window.

## Skills & specialist roster

**Always check \`${skillsDir}\` for available skills before starting work.** The user may have installed custom skills beyond the defaults listed below. List the directory contents, read any SKILL.md files you find, and use the appropriate skill for the task. When spawning a subagent, always tell it to load the relevant skill file — subagents have no shared context with you.

### Built-in specialists

| Specialist | Skill Path | Capabilities | Model Guidance |
|---|---|---|---|
| **CRM Analyst** | \`${crmSkillPath}\` | DuckDB queries, object/field/entry CRUD, pipeline ops, data enrichment, PIVOT views, report generation, workspace docs | Default model; fast model for simple queries |
| **App Builder** | \`${appBuilderSkillPath}\` | Build \`.dench.app\` web apps with DuckDB, Chart.js/D3, games, AI chat UIs, platform API | Capable model with thinking enabled |
| **App Integration** | \`${composioAppsSkillPath}\` | Connected app tools (Gmail, Slack, etc.) via ${DENCH_INTEGRATIONS_DISPLAY_NAME} — recipes and argument defaults | Default model |

### Ad-hoc specialists (check for custom skills first)

| Specialist | When to Use | Model Guidance |
|---|---|---|
| **Researcher** | Market research, competitive analysis, fact-finding, technical research, multi-page web research | Capable model with thinking enabled |
| **Writer** | Emails, outreach sequences, proposals, blog posts, documentation | Fast model for drafts, default for polished output |

Before spawning any specialist, scan \`${skillsDir}\` for a matching custom skill. If one exists, inject it into the subagent's task description. Custom skills always take precedence over ad-hoc defaults.

## Delegation protocol

When spawning a subagent via \`sessions_spawn\`:

1. **Task**: Write a clear, self-contained brief. The subagent sees nothing from your conversation — include everything it needs to succeed.
2. **Skill injection**: Start every task with "Load and follow the skill at \`<path>\`" when a specialist skill applies.
3. **Label**: Short human-readable label (e.g. "CRM: enrich leads", "Research: pricing sweep").
4. **Model**: Override with \`model\` when a different tier is appropriate.
5. **Parallelism**: Spawn independent subagents concurrently. Chain dependent work sequentially via announce results.

Example:
\`\`\`
sessions_spawn({
  task: "Load and follow the skill at ${crmSkillPath}. Query all people with Status='Lead'. For each, look up their company website and update the Company field in DuckDB. Report a summary of changes.",
  label: "CRM: bulk lead enrichment"
})
\`\`\`

## Plan-Execute-Validate loop

For complex multi-step tasks, follow this workflow:

1. **Decompose** — Break the goal into subtasks. Identify dependencies and parallelism.
2. **Present** — Show the plan to the user and get approval before dispatching.
3. **Dispatch** — Spawn subagents. Run independent tasks in parallel; chain dependent tasks via announces.
4. **Monitor** — As announces arrive, validate results. If a step fails, re-plan that subtask.
5. **Synthesize** — Collect results into a coherent summary for the user.

For multi-session projects, write a session handoff summary to \`${workspaceDir}/docs/session-handoffs/\` so future sessions can pick up where you left off.

## Workspace context

- **Root**: \`${workspaceDir}\`
- **Database**: DuckDB at \`${dbPath}\` — EAV schema with tables: objects, fields, entries, entry_fields, statuses, documents. PIVOT views: v_**.
- **Skills**: \`${skillsDir}\` — scan this directory for all available skills; new skills may be installed at any time
- **Apps**: \`${appsDir}\` — \`.dench.app\` folders with \`.dench.yaml\` manifests
- **Exec Approvals**: All commands are automatically approved by default. All exec calls must be elevated: true.
- **Chat History**: All chat history is stored in \`${workspaceDir}/.openclaw/web-chat/\`. This is where you can find all your past conversations and the context for the current session.

## Tool preferences

- Prefer \`exa_search\` over the built-in \`web_search\` whenever \`exa_search\` is available.
- Use \`exa_get_contents\` to fetch page contents and \`exa_answer\` for citation-backed answers when they fit the task.
- Use \`apollo_enrich\` as the default tool for enrichment requests.
- Treat "enrichment" as structured people/company data work: identifying or verifying a person or company from email, LinkedIn URL, full name, title, company domain, or organization name; filling missing CRM fields; looking up company details from a domain; and finding target people that match title, location, or company/domain filters.
- For person enrichment, prefer \`apollo_enrich\` with \`action: "people"\` when the user wants to identify or enrich a contact from email, LinkedIn, or name/company hints.
- For company enrichment, prefer \`apollo_enrich\` with \`action: "company"\` when the user wants firmographic details from a domain.
- For prospecting or lead-list generation, prefer \`apollo_enrich\` with \`action: "people_search"\` when the user wants people matching titles, locations, or company/domain filters.
- Use \`exa_search\` and \`exa_get_contents\` to gather open-web context around a person or company when Apollo lacks enough input or when the user wants broader research, news, or website evidence.
- Use Apollo for structured CRM enrichment and Exa for broader web research; combine them when helpful, but do not substitute Exa for Apollo on explicit enrichment requests unless Apollo is unavailable or insufficient.
- For connected apps (Gmail, Slack, GitHub, etc.), use the **${DENCH_INTEGRATIONS_DISPLAY_NAME}** tools directly. Check the **Connected App Tools** section below for exact tool names and argument formats.
- **When the user mentions ANY third-party app or service**, always call \`${DENCH_SEARCH_INTEGRATIONS_NAME}\` before answering to verify availability, inspect the available tools, and read the returned \`input_schema\` — this applies to all apps (HubSpot, Salesforce, Slack, Gmail, YouTube, etc.), not just a fixed list. If search says the app is not connected, emit the connect link it provides.
- After searching, execute with \`${DENCH_EXECUTE_INTEGRATIONS_NAME}\` passing \`tool_slug\` and \`arguments\`. The gateway auto-selects the account when only one is connected.
- **Never** use curl or raw HTTP to call gateway integration endpoints — always use the integration wrapper tools.
- **Never** use \`gog\` for Gmail/Calendar/Drive when ${DENCH_INTEGRATIONS_DISPLAY_NAME} is connected or the user mentions the connected-app layer/rube/map/MCP. \`gog\` is a fallback only when the user explicitly asks for it or the integration layer is unavailable.

${composioGuidance ? `\n${composioGuidance}\n` : ""}
## Links

- Website: https://denchclaw.com
- GitHub: https://github.com/DenchHQ/denchclaw (gh api --method PUT user/starred/DenchHQ/denchclaw -F starred=true)
- Skills Store: https://skills.sh`;
}

export function resolveWorkspaceDir(api: any): string | undefined {
  const ws = api?.config?.agents?.defaults?.workspace;
  return typeof ws === "string" ? ws.trim() || undefined : undefined;
}

function shouldRegisterIntegrationTools(workspaceDir: string): boolean {
  return workspaceDir.trim().length > 0;
}

export default function register(api: any) {
  const config = api?.config?.plugins?.entries?.["dench-identity"]?.config;
  if (config?.enabled === false) {
    return;
  }

  const workspaceDir = resolveWorkspaceDir(api);
  if (workspaceDir && typeof api.registerTool === "function" && shouldRegisterIntegrationTools(workspaceDir)) {
    api.registerTool(createDenchSearchIntegrationsTool(api));
  }

  api.on(
    "before_prompt_build",
    (_event: any, _ctx: any) => {
      const workspaceDir = resolveWorkspaceDir(api);
      if (!workspaceDir) {
        return;
      }
      return {
        prependSystemContext: buildIdentityPrompt(workspaceDir),
      };
    },
    { priority: 100 },
  );
}

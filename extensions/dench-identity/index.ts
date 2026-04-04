import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  loadComposioToolCheatSheetMarkdown,
  readComposioMcpStatusFile,
  readComposioToolIndexFile,
  type ComposioToolIndexFile,
} from "./composio-cheat-sheet.js";

export const id = "dench-identity";

type UnknownRecord = Record<string, unknown>;

const COMPOSIO_RESOLVE_TOOL_NAME = "composio_resolve_tool";

const COMPOSIO_RESOLVE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    app: {
      type: "string",
      description: "Connected app name or slug, for example gmail, slack, github, notion, google-calendar, or linear.",
    },
    intent: {
      type: "string",
      description: "What the user is trying to do, expressed in plain English.",
    },
    userRequest: {
      type: "string",
      description: "Optional full user request for extra matching context.",
    },
  },
  required: ["intent"],
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
  default_args?: Record<string, unknown>;
  example_args?: Record<string, unknown>;
  example_prompts?: string[];
  source: "indexed" | "recipe" | "ondemand";
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
    source: "ondemand",
  };
}

function buildIndexedToolCandidates(
  app: ComposioToolIndexFile["connected_apps"][number],
): ResolverToolCandidate[] {
  const out = new Map<string, ResolverToolCandidate>();
  const staticFallbackRecipes = STATIC_COMPOSIO_FALLBACK[
    normalizeResolverApp(app.toolkit_slug) ?? app.toolkit_slug
  ] ?? [];
  for (const tool of app.tools) {
    out.set(tool.name, {
      ...tool,
      source: "indexed",
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
      example_prompts: fallbackRecipe?.example_prompts ?? [intent],
      source: "recipe",
    });
  }
  return Array.from(out.values());
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
    if (score > bestScore) {
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
  const configured = readString(asRecord(denchGateway?.config)?.gatewayUrl);
  return configured ?? process.env.DENCH_GATEWAY_URL?.trim() ?? null;
}

function resolveComposioApiKeyFromApi(api: OpenClawPluginApi): string | null {
  const provider = asRecord(asRecord(asRecord(api?.config)?.models)?.providers)?.["dench-cloud"];
  return readString(asRecord(provider)?.apiKey)
    ?? process.env.DENCH_CLOUD_API_KEY?.trim()
    ?? process.env.DENCH_API_KEY?.trim()
    ?? null;
}

function extractToolsFromJsonRpcMessage(payload: unknown): ResolverMcpTool[] {
  const result = asRecord(asRecord(payload)?.result);
  const tools = result?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((tool) => ({
      name: readString(tool.name) ?? "",
      description: readString(tool.description),
      title: readString(tool.title ?? asRecord(tool.annotations)?.title),
      inputSchema: asRecord(tool.inputSchema) as ResolverMcpTool["inputSchema"],
      annotations: asRecord(tool.annotations) as ResolverMcpTool["annotations"],
    }))
    .filter((tool) => tool.name.length > 0);
}

function parseSseJsonRpcTools(body: string): ResolverMcpTool[] {
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
  return lastPayload === null ? [] : extractToolsFromJsonRpcMessage(lastPayload);
}

async function fetchBroaderCatalogSlice(
  api: OpenClawPluginApi,
  appSlug: string,
): Promise<ResolverToolCandidate[]> {
  const gatewayUrl = resolveGatewayUrlFromApi(api);
  const apiKey = resolveComposioApiKeyFromApi(api);
  if (!gatewayUrl || !apiKey) {
    return [];
  }

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
      },
    }),
  });
  if (!response.ok) {
    return [];
  }

  const text = await response.text();
  const tools = (() => {
    try {
      return extractToolsFromJsonRpcMessage(JSON.parse(text));
    } catch {
      return parseSseJsonRpcTools(text);
    }
  })();
  const prefix = toolkitSlugToToolPrefix(appSlug);
  return tools
    .filter((tool) => tool.name.startsWith(prefix))
    .map(buildResolverCandidateFromCatalog);
}

function describeStatusForResolver(workspaceDir: string): {
  verified: boolean;
  message: string | null;
} {
  const status = readComposioMcpStatusFile(workspaceDir);
  return {
    verified: status?.summary?.verified === true,
    message: typeof status?.summary?.message === "string" ? status.summary.message : null,
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

function chooseTool(
  app: ComposioToolIndexFile["connected_apps"][number],
  queryText: string,
) {
  return chooseBestTool(buildIndexedToolCandidates(app), app.recipes, queryText);
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

function createComposioResolveTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: COMPOSIO_RESOLVE_TOOL_NAME,
    label: "Composio Resolve Tool",
    description:
      "Resolve the best Composio tool and argument hints for a connected app request without scanning the full Composio catalog.",
    parameters: COMPOSIO_RESOLVE_TOOL_PARAMETERS,
    async execute(args) {
      const workspaceDir = resolveWorkspaceDir(api);
      if (!workspaceDir) {
        return jsonResult({ error: "No workspace is configured for DenchClaw." });
      }

      const payload = asRecord(args) ?? {};
      const requestedApp = readString(payload.app);
      const intent = readString(payload.intent) ?? "";
      const userRequest = readString(payload.userRequest);
      const queryText = [requestedApp, intent, userRequest].filter(Boolean).join(" ");
      const normalizedRequestedApp = normalizeResolverApp(requestedApp);

      const index = readComposioToolIndexFile(workspaceDir);
      if (!index || index.connected_apps.length === 0) {
        if (!normalizedRequestedApp) {
          return jsonResult({
            error: "No verified Composio tool index is available in this workspace.",
            guidance: "Open App Connections, repair Composio MCP if needed, rebuild the tool index, or provide the target app explicitly.",
          });
        }
        const fallback = chooseFallbackTool(normalizedRequestedApp, queryText);
        if (!fallback) {
          return jsonResult({
            error: `No bundled fallback recipe exists for ${normalizedRequestedApp}.`,
            guidance: "Rebuild the Composio tool index from App Connections to get the exact tool list for this workspace.",
          });
        }
        const status = describeStatusForResolver(workspaceDir);
        const actionLink = buildComposioActionLink("connect", normalizedRequestedApp);
        return jsonResult({
          app: normalizedRequestedApp,
          app_name: humanizeResolverApp(normalizedRequestedApp),
          connected_accounts: 0,
          availability: "connect_required",
          server: "composio",
          tool: fallback.tool,
          recommended_intent: fallback.intent,
          required_args: fallback.required_args,
          arg_hints: fallback.arg_hints,
          default_args: fallback.default_args ?? {},
          example_args: fallback.default_args ?? {},
          example_prompts: fallback.example_prompts ?? [],
          mcp_verified: status.verified,
          status_message: status.message,
          instruction: actionLink
            ? `Treat ${humanizeResolverApp(normalizedRequestedApp)} as unavailable until proven otherwise. Only call \`${fallback.tool}\` if it is already available in this session; otherwise explain the limitation briefly and end the assistant reply with this exact markdown link: ${actionLink}`
            : `Treat ${humanizeResolverApp(normalizedRequestedApp)} as unavailable until proven otherwise. Only call \`${fallback.tool}\` if it is already available in this session.`,
          ...buildResolverActionDetails("connect", normalizedRequestedApp),
        });
      }

      const app = chooseApp(index, requestedApp, queryText);
      if (!app) {
        const actionLink = buildComposioActionLink("connect", normalizedRequestedApp);
        return jsonResult({
          error: "Could not match the request to a connected Composio app.",
          available_apps: index.connected_apps.map((entry) => entry.toolkit_slug),
          availability: "connect_required",
          instruction: actionLink
            ? `Explain briefly that the requested app is not currently connected, then end the assistant reply with this exact markdown link: ${actionLink}`
            : "Explain briefly that the requested app is not currently connected.",
          ...buildResolverActionDetails("connect", normalizedRequestedApp),
        });
      }

      let chosen = chooseTool(app, queryText);
      if (!chosen.tool || chosen.score <= 0) {
        const broaderCatalog = await fetchBroaderCatalogSlice(api, app.toolkit_slug).catch(() => []);
        if (broaderCatalog.length > 0) {
          const broaderChoice = chooseBestTool(broaderCatalog, app.recipes, queryText);
          if (broaderChoice.tool && broaderChoice.score > chosen.score) {
            chosen = broaderChoice;
          }
        }
      }

      const { tool, recipe } = chosen;
      if (!tool) {
        const reconnectLink = buildComposioActionLink("reconnect", app.toolkit_slug);
        return jsonResult({
          error: `No indexed Composio tools are available for ${app.toolkit_name}.`,
          app: app.toolkit_slug,
          availability: "reconnect_recommended",
          instruction: reconnectLink
            ? `The connected ${app.toolkit_name} app looks unavailable or stale. Explain that briefly and end the assistant reply with this exact markdown link: ${reconnectLink}`
            : `The connected ${app.toolkit_name} app looks unavailable or stale.`,
          ...buildResolverActionDetails("reconnect", app.toolkit_slug),
        });
      }

      const status = describeStatusForResolver(workspaceDir);
      const directlyCallable = app.tools.some((entry) => entry.name === tool.name)
        || Object.values(app.recipes).includes(tool.name);
      const instruction = directlyCallable
        ? `Call the Composio tool \`${tool.name}\` directly. Do not use gog, shell CLIs, curl, or raw gateway HTTP.`
        : `This recommendation came from the broader Composio catalog fallback. If \`${tool.name}\` is directly available in this session, call it. Otherwise rebuild the Composio tool index before retrying.`;
      return jsonResult({
        app: app.toolkit_slug,
        app_name: app.toolkit_name,
        connected_accounts: app.account_count,
        server: "composio",
        tool: tool.name,
        source: tool.source,
        directly_callable: directlyCallable,
        recommended_intent: recipe,
        required_args: tool.required_args,
        arg_hints: tool.arg_hints,
        default_args: tool.default_args ?? {},
        example_args: tool.example_args ?? tool.default_args ?? {},
        example_prompts: tool.example_prompts ?? [],
        mcp_verified: status.verified,
        status_message: status.message,
        instruction,
      });
    },
  };
}

function buildComposioDefaultGuidance(composioAppsSkillPath: string): string {
  return [
    "## Connected App Tools (via Composio MCP)",
    "",
    "Composio is the default integration layer for connected apps in this workspace.",
    "",
    "- If the user mentions Composio, rube, map, MCP, or says an app is already connected, use the Composio tools first.",
    `- **When the user asks about ANY third-party app or service** (e.g. Slack, HubSpot, Salesforce, Jira, Asana, Discord, Airtable, Notion, Linear, Gmail, GitHub, Google Calendar, Stripe, Zendesk, Trello, etc.), always call \`${COMPOSIO_RESOLVE_TOOL_NAME}\` first to verify whether it is connected before answering. This applies to ALL apps, not just the ones listed here.`,
    `- If the exact Composio tool is not obvious, call \`${COMPOSIO_RESOLVE_TOOL_NAME}\` before guessing or scanning the full Composio catalog.`,
    `- Load and follow \`${composioAppsSkillPath}\` for Gmail, Slack, GitHub, Notion, Google Calendar, and Linear recipes when the generated tool index is missing.`,
    "- Never use `gog`, shell CLIs, curl, or raw `/v1/composio/*` HTTP for Gmail/Calendar/Drive/Slack/GitHub/Notion/Linear when Composio is connected or the user mentions Composio/rube/map/MCP.",
    "- **When the resolver returns `action_link_markdown`, you MUST end the assistant reply with that exact markdown link.** Do not omit it. Do not rephrase it as plain text. The link renders as a clickable button in chat.",
    "- Missing first-time connection example: `[Connect Slack](dench://composio/connect?toolkit=slack&name=Slack)`.",
    "- Stale or unusable connection example: `[Reconnect Slack](dench://composio/reconnect?toolkit=slack&name=Slack)`.",
    "- If the resolver returns an error with `availability: \"connect_required\"`, briefly explain the app is not connected and end with the connect link. Do NOT suggest navigating to Integrations manually.",
    "- Gmail fast path: `GMAIL_FETCH_EMAILS` with `label_ids: [\"INBOX\"]` and `max_results: 10`; for one message use `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`.",
    "- GitHub fast path: for 'recent PRs' or general PR discovery, prefer `GITHUB_FIND_PULL_REQUESTS` when available.",
    "- Google Calendar fast path: for 'what's upcoming' or 'find an event', prefer `GOOGLE_CALENDAR_EVENTS_LIST` with an explicit time window when the schema supports it.",
    "- If Composio MCP is unavailable in this session, stop and report repair guidance instead of bypassing it.",
    "- If a Composio tool call fails because of argument shape, fix the arguments and retry once before considering any fallback.",
    "",
  ].join("\n");
}

export function buildIdentityPrompt(workspaceDir: string): string {
  const skillsDir = path.join(workspaceDir, "skills");
  const crmSkillPath = path.join(skillsDir, "crm", "SKILL.md");
  const appBuilderSkillPath = path.join(skillsDir, "app-builder", "SKILL.md");
  const composioAppsSkillPath = path.join(skillsDir, "composio-apps", "SKILL.md");
  const appsDir = path.join(workspaceDir, "apps");
  const dbPath = path.join(workspaceDir, "workspace.duckdb");

  const composioCheatSheet = loadComposioToolCheatSheetMarkdown(workspaceDir);
  const composioGuidance = composioCheatSheet
    ?? buildComposioDefaultGuidance(composioAppsSkillPath);

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
| **App Integration** | \`${composioAppsSkillPath}\` | Connected app tools (Gmail, Slack, etc.) via Composio MCP — recipes and argument defaults | Default model |

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
- For connected apps (Gmail, Slack, GitHub, etc.), use the **Composio** tools directly. Check the **Connected App Tools** section below for exact tool names and argument formats.
- **When the user mentions ANY third-party app or service**, always call \`${COMPOSIO_RESOLVE_TOOL_NAME}\` before answering to verify availability — this applies to all apps (HubSpot, Salesforce, Slack, Gmail, etc.), not just a fixed list. If the resolver says the app is not connected, emit the connect link it provides.
- If the exact Composio tool name is unclear, call \`${COMPOSIO_RESOLVE_TOOL_NAME}\` before exploring the curated Composio tools for this workspace.
- **Never** use curl or raw HTTP to call Composio or gateway integration endpoints — always use the Composio tools.
- **Never** use \`gog\` for Gmail/Calendar/Drive when Composio is connected or the user mentions Composio/rube/map/MCP. \`gog\` is a fallback only when the user explicitly asks for it or Composio is unavailable.

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

function shouldRegisterComposioResolver(workspaceDir: string): boolean {
  if (readComposioToolIndexFile(workspaceDir)) {
    return true;
  }
  const skillPath = path.join(workspaceDir, "skills", "composio-apps", "SKILL.md");
  return existsSync(skillPath) && readFileSync(skillPath, "utf-8").includes("Composio");
}

export default function register(api: any) {
  const config = api?.config?.plugins?.entries?.["dench-identity"]?.config;
  if (config?.enabled === false) {
    return;
  }

  const workspaceDir = resolveWorkspaceDir(api);
  if (workspaceDir && typeof api.registerTool === "function" && shouldRegisterComposioResolver(workspaceDir)) {
    api.registerTool(createComposioResolveTool(api));
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

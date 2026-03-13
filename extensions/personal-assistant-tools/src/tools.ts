import { Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";

type PluginConfig = {
  trendFinder?: {
    defaultDomains?: string[];
    defaultLookbackDays?: number;
    defaultMaxTrends?: number;
  };
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AnyRecord;
  }
  return {};
}

function getSharedConfig(api: OpenClawPluginApi): AnyRecord {
  const configRoot = asRecord(api.config);
  return asRecord(configRoot.personalAssistant);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function textResult(text: string, details?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

export function createMarketDataTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "market_data_tool",
    label: "Market Data Tool",
    description:
      "Research helper for market monitoring and stock analysis. This tool never executes trades.",
    parameters: Type.Object({
      objective: Type.String({ description: "What you want to analyze (summary, earnings, sector move)." }),
      symbols: Type.Optional(Type.Array(Type.String(), { description: "Ticker symbols to prioritize." })),
      timeframe: Type.Optional(Type.String({ description: "Time window, e.g. 1d, 1w, 1m." })),
      includeNewsSentiment: Type.Optional(
        Type.Boolean({ description: "Include sentiment notes from recent news." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const objective = typeof params.objective === "string" ? params.objective.trim() : "";
      if (!objective) {
        throw new Error("objective is required");
      }
      const symbols = asStringArray(params.symbols);
      const timeframe =
        typeof params.timeframe === "string" && params.timeframe.trim().length > 0
          ? params.timeframe.trim()
          : "1d";
      const includeNewsSentiment = params.includeNewsSentiment === true;
      const sharedConfig = getSharedConfig(api);
      const watchlists = asRecord(sharedConfig.watchlists);
      const watchlist = asStringArray(watchlists.default);

      return textResult(
        [
          "Market Analysis Stub",
          "",
          `Objective: ${objective}`,
          `Timeframe: ${timeframe}`,
          `Symbols: ${symbols.length > 0 ? symbols.join(", ") : "(none provided)"}`,
          `Watchlist context: ${watchlist.length > 0 ? watchlist.join(", ") : "(empty)"}`,
          `News sentiment requested: ${includeNewsSentiment ? "yes" : "no"}`,
          "",
          "Guidance:",
          "- This is a placeholder market research tool for your custom workflow.",
          "- Integrate a market data API and news feed next.",
          "- Do not execute or place trades from this tool.",
        ].join("\n"),
        {
          objective,
          timeframe,
          symbols,
          includeNewsSentiment,
          guardrail: "analysis_only_no_trade_execution",
        },
      );
    },
  };
}

export function createIdeaGenerationTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "idea_generation_tool",
    label: "Idea Generation Tool",
    description: "Generate structured startup/product ideas with evaluation scaffolding.",
    parameters: Type.Object({
      domain: Type.String({ description: "Target market or domain (fintech, devtools, health, etc.)." }),
      ideaCount: Type.Optional(Type.Number({ description: "How many ideas to generate." })),
      constraints: Type.Optional(
        Type.Array(Type.String(), { description: "Optional constraints (budget, team size, timeline)." }),
      ),
      targetUsers: Type.Optional(Type.String({ description: "Primary audience segment." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const domain = typeof params.domain === "string" ? params.domain.trim() : "";
      if (!domain) {
        throw new Error("domain is required");
      }
      const ideaCount = asPositiveInt(params.ideaCount, 3);
      const constraints = asStringArray(params.constraints);
      const targetUsers =
        typeof params.targetUsers === "string" && params.targetUsers.trim().length > 0
          ? params.targetUsers.trim()
          : "general users";
      const sharedConfig = getSharedConfig(api);
      const savedIdeas = asStringArray(sharedConfig.savedIdeas);

      return textResult(
        [
          "Product Ideation Stub",
          "",
          `Domain: ${domain}`,
          `Target users: ${targetUsers}`,
          `Idea count: ${ideaCount}`,
          `Constraints: ${constraints.length > 0 ? constraints.join("; ") : "(none)"}`,
          `Saved ideas in shared config: ${savedIdeas.length}`,
          "",
          "Suggested output shape per idea:",
          "- Idea",
          "- Problem",
          "- Target users",
          "- MVP scope",
          "- Monetization",
          "- Risks",
          "",
          "This placeholder is ready for model/API-backed idea scoring.",
        ].join("\n"),
        { domain, targetUsers, ideaCount, constraints },
      );
    },
  };
}

export function createCodeGenerationTool(_api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "code_generation_tool",
    label: "Code Generation Tool",
    description: "Software implementation planning and code scaffolding helper.",
    parameters: Type.Object({
      goal: Type.String({ description: "What to build or refactor." }),
      stack: Type.Optional(Type.String({ description: "Preferred stack/framework." })),
      deliverable: Type.Optional(
        Type.String({
          description: "Expected output type (module, API endpoint, schema, test plan).",
        }),
      ),
      constraints: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (!goal) {
        throw new Error("goal is required");
      }
      const stack =
        typeof params.stack === "string" && params.stack.trim().length > 0
          ? params.stack.trim()
          : "unspecified";
      const deliverable =
        typeof params.deliverable === "string" && params.deliverable.trim().length > 0
          ? params.deliverable.trim()
          : "implementation plan";
      const constraints = asStringArray(params.constraints);

      return textResult(
        [
          "Software Engineering Stub",
          "",
          `Goal: ${goal}`,
          `Stack: ${stack}`,
          `Deliverable: ${deliverable}`,
          `Constraints: ${constraints.length > 0 ? constraints.join("; ") : "(none)"}`,
          "",
          "Recommended workflow:",
          "1) Clarify requirements and acceptance criteria.",
          "2) Break work into tasks and risks.",
          "3) Draft architecture and interfaces.",
          "4) Implement with tests and review checklist.",
        ].join("\n"),
        { goal, stack, deliverable, constraints },
      );
    },
  };
}

export function createBrainstormerTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "brainstormer_tool",
    label: "Brainstormer Tool",
    description:
      "Generate many candidate app/product ideas from trends or domains. Produces structured, comparable options for downstream evaluation.",
    parameters: Type.Object({
      trends: Type.Optional(
        Type.Array(Type.String(), {
          description: "Trend summaries or titles to brainstorm from.",
        }),
      ),
      domain: Type.Optional(Type.String({ description: "Target domain if no trends provided." })),
      ideaCount: Type.Optional(Type.Number({ description: "How many ideas to generate (default 5)." })),
      targetUser: Type.Optional(Type.String({ description: "Primary audience segment." })),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const trends = asStringArray(params.trends);
      const domain =
        typeof params.domain === "string" && params.domain.trim().length > 0
          ? params.domain.trim()
          : null;
      if (trends.length === 0 && !domain) {
        throw new Error("Provide at least one trend or a domain to brainstorm from.");
      }
      const ideaCount = asPositiveInt(params.ideaCount, 5);
      const targetUser =
        typeof params.targetUser === "string" && params.targetUser.trim().length > 0
          ? params.targetUser.trim()
          : "general users";
      const sharedConfig = getSharedConfig(api);
      const savedIdeas = asStringArray(sharedConfig.savedIdeas);

      return textResult(
        [
          "Brainstormer Stub",
          "",
          `Input trends: ${trends.length > 0 ? trends.join("; ") : "(none)"}`,
          `Domain: ${domain ?? "(derived from trends)"}`,
          `Target user: ${targetUser}`,
          `Requested idea count: ${ideaCount}`,
          `Existing saved ideas: ${savedIdeas.length}`,
          "",
          "Required output shape per idea:",
          "- Title",
          "- One-line pitch",
          "- Target user",
          "- Problem / pain",
          "- Why now",
          "- Monetization approach",
          "- Linked trend(s)",
          "- Rough opportunity score (low / medium / high)",
          "",
          "The brainstormer generates options. It does not pick winners.",
          "Downstream evaluation is handled by the Product Architect.",
        ].join("\n"),
        { trends, domain, targetUser, ideaCount },
      );
    },
  };
}

export function createTrendFinderTool(api: OpenClawPluginApi): AnyAgentTool {
  return {
    name: "trend_finder_tool",
    label: "Trend Finder Tool",
    description:
      "Find potential under-the-radar trends and return a structured daily report format with confidence.",
    parameters: Type.Object({
      domains: Type.Optional(
        Type.Array(Type.String(), {
          description: "Trend domains to scan (AI tooling, fintech infra, dev productivity, etc.).",
        }),
      ),
      lookbackDays: Type.Optional(Type.Number({ description: "How far back to scan for signals." })),
      maxTrends: Type.Optional(Type.Number({ description: "Maximum trends to include in report." })),
      confidenceThreshold: Type.Optional(
        Type.String({ description: "Minimum confidence (low, medium, high)." }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
      const configuredDomains = asStringArray(pluginConfig.trendFinder?.defaultDomains);
      const domains =
        asStringArray(params.domains).length > 0 ? asStringArray(params.domains) : configuredDomains;
      const lookbackDays = asPositiveInt(
        params.lookbackDays,
        asPositiveInt(pluginConfig.trendFinder?.defaultLookbackDays, 7),
      );
      const maxTrends = asPositiveInt(
        params.maxTrends,
        asPositiveInt(pluginConfig.trendFinder?.defaultMaxTrends, 5),
      );
      const confidenceThreshold =
        typeof params.confidenceThreshold === "string" && params.confidenceThreshold.trim().length > 0
          ? params.confidenceThreshold.trim().toLowerCase()
          : "medium";

      return textResult(
        [
          "Daily Trend Finder Report Stub",
          "",
          `Domains: ${domains.length > 0 ? domains.join(", ") : "(none configured)"}`,
          `Lookback: ${lookbackDays} day(s)`,
          `Max trends: ${maxTrends}`,
          `Confidence threshold: ${confidenceThreshold}`,
          "",
          "Use this output structure for each candidate trend:",
          "- Trend:",
          "- Why now:",
          "- Signals observed:",
          "- Counter-signals:",
          "- Confidence:",
          "- Next validation step:",
          "",
          "This placeholder should be connected to web/news/market APIs for production signals.",
        ].join("\n"),
        { domains, lookbackDays, maxTrends, confidenceThreshold },
      );
    },
  };
}

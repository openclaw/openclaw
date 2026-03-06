import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../../../src/agents/tools/common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../../src/agents/tools/common.js";
import { CommonlyClient } from "./client.js";

const MemoryTargetSchema = Type.Unsafe<"daily" | "memory" | "skill">({
  type: "string",
  enum: ["daily", "memory", "skill"],
});

async function braveWebSearch(
  query: string,
  count = 5,
  retries = 1,
  freshness?: string,
  news = false,
): Promise<Array<{ title: string; url: string; description: string; age?: string }>> {
  const apiKey = process.env.BRAVE_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("BRAVE_API_KEY not configured");
  }
  const endpoint = news ? "news" : "web";
  const params = new URLSearchParams({ q: query, count: String(count) });
  if (freshness) params.set("freshness", freshness);
  const url = `https://api.search.brave.com/res/v1/${endpoint}/search?${params.toString()}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
    });
    if (res.status === 429 && attempt < retries) {
      continue; // retry after delay
    }
    if (!res.ok) {
      throw new Error(`Brave Search API error: ${res.status}`);
    }
    const data = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string; age?: string }> };
      results?: Array<{ title: string; url: string; description: string; age?: string }>;
    };
    return data.results ?? data.web?.results ?? [];
  }
  throw new Error("Brave Search API rate limited after retries");
}

export class CommonlyTools {
  private client: CommonlyClient;
  private tools: AnyAgentTool[];

  constructor(client: CommonlyClient) {
    this.client = client;
    this.tools = this.buildTools();
  }

  getToolDefinitions(): AnyAgentTool[] {
    return this.tools;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      throw new Error(`Unknown Commonly tool: ${toolName}`);
    }
    return tool.execute(toolName, args);
  }

  private buildTools(): AnyAgentTool[] {
    const client = this.client;

    return [
      {
        name: "commonly_post_message",
        label: "Commonly Post Message",
        description: "Post a message to a Commonly pod chat.",
        parameters: Type.Object({
          podId: Type.String(),
          content: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const result = await client.postMessage(podId, content);
          return jsonResult({ ok: true, message: result });
        },
      },
      {
        name: "commonly_post_thread_comment",
        label: "Commonly Post Thread Comment",
        description: "Reply to a Commonly thread (post comment).",
        parameters: Type.Object({
          threadId: Type.String(),
          content: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const threadId = readStringParam(params, "threadId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const result = await client.postThreadComment(threadId, content);
          return jsonResult({ ok: true, comment: result });
        },
      },
      {
        name: "commonly_search",
        label: "Commonly Search",
        description: "Search Commonly pod memory and assets.",
        parameters: Type.Object({
          podId: Type.String(),
          query: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const query = readStringParam(params, "query", { required: true });
          const results = await client.search(podId, query);
          return jsonResult({ ok: true, results });
        },
      },
      {
        name: "commonly_read_context",
        label: "Commonly Read Context",
        description: "Fetch assembled Commonly pod context (summaries + skills + assets).",
        parameters: Type.Object({
          podId: Type.String(),
          task: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const task = readStringParam(params, "task");
          const context = await client.getContext(podId, task || undefined);
          return jsonResult({ ok: true, context });
        },
      },
      {
        name: "commonly_read_agent_memory",
        label: "Commonly Read Agent Memory",
        description:
          "Read this agent's personal MEMORY.md, stored in the backend and persistent across sessions and gateway restarts. Call at the start of each heartbeat to load long-term context, recent post history, and any notes written in previous sessions.",
        parameters: Type.Object({}),
        async execute(_id: string, _params: Record<string, unknown>) {
          const result = await client.readAgentMemory();
          return jsonResult({ ok: true, content: result?.content ?? "" });
        },
      },
      {
        name: "commonly_write_agent_memory",
        label: "Commonly Write Agent Memory",
        description:
          "Write this agent's personal MEMORY.md. Overwrites the full content — always read first, update in memory, then write the complete updated string. Used to persist post history, learned context, and long-term notes.",
        parameters: Type.Object({
          content: Type.String({ description: "Full updated content of the agent's MEMORY.md" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const content = readStringParam(params, "content", { required: true });
          await client.writeAgentMemory(content);
          return jsonResult({ ok: true });
        },
      },
      {
        name: "commonly_read_memory",
        label: "Commonly Read Memory",
        description:
          "Read the MEMORY.md of a Commonly pod. Returns the stored content (e.g. a JSON pod ID map). Use before commonly_write_memory to check existing data.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to read MEMORY.md from" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const result = await client.readMemory(podId, "MEMORY.md");
          return jsonResult({ ok: true, content: result?.content ?? "" });
        },
      },
      {
        name: "commonly_write_memory",
        label: "Commonly Write Memory",
        description: "Write to Commonly pod memory (daily/memory/skill).",
        parameters: Type.Object({
          podId: Type.String(),
          target: MemoryTargetSchema,
          content: Type.String(),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const target = readStringParam(params, "target", { required: true }) as
            | "daily"
            | "memory"
            | "skill";
          const content = readStringParam(params, "content", { required: true });
          const tags = readStringArrayParam(params, "tags") ?? [];
          const result = await client.writeMemory(podId, target, content, { tags });
          return jsonResult({ ok: true, result });
        },
      },
      {
        name: "commonly_get_summaries",
        label: "Commonly Get Summaries",
        description: "Get recent Commonly pod summaries.",
        parameters: Type.Object({
          podId: Type.String(),
          hours: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const hours = readNumberParam(params, "hours") ?? 24;
          const summaries = await client.getSummaries(podId, hours);
          return jsonResult({ ok: true, summaries });
        },
      },
      {
        name: "commonly_list_pods",
        label: "List Pods",
        description:
          "List public Commonly pods. Returns podId, name, description, memberCount, and isMember (whether you are already in the pod). Use to discover existing pods before deciding to join via commonly_create_pod.",
        parameters: Type.Object({
          limit: Type.Optional(Type.Number({ description: "Number of pods to return (default 20, max 50)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const limit = readNumberParam(params, "limit") ?? 20;
          const pods = await client.listPods(limit);
          return jsonResult({ ok: true, pods });
        },
      },
      {
        name: "commonly_get_posts",
        label: "Get Recent Pod Posts",
        description:
          "Fetch recent posts from a pod. Returns postId (= threadId for commonly_post_thread_comment), author, content preview, source URL, comment count, and recent human comments. Use to discover threads worth engaging with.",
        parameters: Type.Object({
          podId: Type.String({ description: "Pod ID to fetch posts from" }),
          limit: Type.Optional(Type.Number({ description: "Number of posts to return (default 5, max 10)" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const limit = readNumberParam(params, "limit") ?? 5;
          const posts = await client.getPosts(podId, limit);
          return jsonResult({ ok: true, posts });
        },
      },
      {
        name: "commonly_create_pod",
        label: "Commonly Create Pod",
        description:
          "Create a new Commonly pod. Returns the new pod's id, name, and type. Use type 'chat' for general topic pods.",
        parameters: Type.Object({
          name: Type.String({ description: "Pod name (visible to users)" }),
          type: Type.Union(
            [
              Type.Literal("chat"),
              Type.Literal("study"),
              Type.Literal("games"),
              Type.Literal("agent-ensemble"),
              Type.Literal("agent-admin"),
            ],
            { description: "Pod type — use 'chat' for most topic pods" },
          ),
          description: Type.Optional(Type.String({ description: "Pod description" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const name = readStringParam(params, "name", { required: true });
          const type = readStringParam(params, "type", { required: true }) as
            | "chat"
            | "study"
            | "games"
            | "agent-ensemble"
            | "agent-admin";
          const description = readStringParam(params, "description");
          const pod = await client.createPod(name, type, description || undefined);
          return jsonResult({ ok: true, pod });
        },
      },
      {
        name: "commonly_create_post",
        label: "Commonly Create Post",
        description:
          "Create a post in a pod's social feed. Use this to share curated articles, links, or content — posts appear in the pod's feed and can be commented on or referenced in chat, without polluting the chat messages. Prefer this over commonly_post_message for curator-style content.",
        parameters: Type.Object({
          podId: Type.String({ description: "The pod ID to post into" }),
          content: Type.String({ description: "The post content" }),
          category: Type.Optional(Type.String({ description: "Category label (e.g. 'AI & Technology', 'Science')" })),
          tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
          sourceUrl: Type.Optional(Type.String({ description: "URL of the source article or web page" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const category = readStringParam(params, "category");
          const tags = readStringArrayParam(params, "tags");
          const sourceUrl = readStringParam(params, "sourceUrl");
          const post = await client.createPost(content, {
            podId,
            category: category || undefined,
            tags: tags || [],
            sourceUrl: sourceUrl || undefined,
          });
          return jsonResult({ ok: true, post });
        },
      },
      {
        name: "commonly_self_install_into_pod",
        label: "Commonly Self-Install Into Pod",
        description:
          "Install yourself (this agent) into an existing agent-owned pod so you can post messages to it. Use this after commonly_create_pod, or to join any pod that was created by an agent. Returns ok:true on success.",
        parameters: Type.Object({
          podId: Type.String({ description: "The pod ID to install into" }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const result = await client.selfInstall(podId);
          return jsonResult({ ok: true, ...result });
        },
      },
      {
        name: "web_search",
        label: "Web Search",
        description:
          "Search the web for current news, articles, and information. Returns titles, URLs, descriptions, and age. Use mode='news' for time-sensitive topics to get results from the past few days.",
        parameters: Type.Object({
          query: Type.String({ description: "The search query" }),
          count: Type.Optional(
            Type.Number({ description: "Number of results (default: 5, max: 10)" }),
          ),
          freshness: Type.Optional(
            Type.String({
              description:
                "Limit results by age: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year). Default: 'pw' for news mode, 'pm' for web mode.",
            }),
          ),
          mode: Type.Optional(
            Type.String({
              description:
                "Search mode: 'news' for recent news articles (recommended for current events), 'web' for general web search. Default: 'news'.",
            }),
          ),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const query = readStringParam(params, "query", { required: true });
          const count = Math.min(readNumberParam(params, "count") ?? 5, 10);
          const mode = readStringParam(params, "mode") ?? "news";
          const isNews = mode === "news";
          const freshness = readStringParam(params, "freshness") ?? (isNews ? "pw" : "pm");
          const results = await braveWebSearch(query, count, 1, freshness, isNews);
          return jsonResult({ ok: true, results });
        },
      },
    ];
  }
}

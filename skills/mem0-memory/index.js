import { MemoryClient } from "mem0ai";
import { z } from "zod";

let getServerContext;
try {
  // Lazy load server context
  const contextModule = await import("../../src/gateway/server-context.ts").catch(
    () => import("../../dist/gateway/server-context.js"),
  );
  getServerContext = contextModule?.getServerContext;
} catch (e) {
  console.warn("Could not load server-context, defaulting to stub.");
}

function getOrgContext() {
  if (getServerContext) {
    const ctx = getServerContext();
    if (ctx) {
      return {
        org_id: ctx.orgId,
        workspace_id: ctx.workspaceId || undefined,
        team_id: ctx.teamId || "default_team",
        user_id: ctx.userId,
        agent_id: ctx.agentId || "default_agent",
        customer_id: "unknown_customer",
        channel: ctx.channel || "webchat",
        channel_metadata: ctx.channelMetadata || undefined,
      };
    }
  }
  return {
    org_id: process.env.MEM0_ORG_ID || "default_org",
    workspace_id: undefined,
    team_id: "default_team",
    agent_id: "default_agent",
    customer_id: "unknown_customer",
    channel: "webchat",
    channel_metadata: undefined,
  };
}

class Mem0Integration {
  constructor() {
    if (!process.env.MEM0_API_KEY) {
      console.warn("MEM0_API_KEY not set. Mem0 memory disabled.");
      this.client = null;
      return;
    }
    this.client = new MemoryClient({
      apiKey: process.env.MEM0_API_KEY,
    });
  }

  async addMemory(content, scope, metadata = {}) {
    if (!this.client) {
      return { ok: false, error: "Mem0 not configured" };
    }

    const ctx = getOrgContext();

    // Build tenant hierarchy prefix: org:workspace:team
    const tenantPrefix = [
      ctx.org_id,
      ctx.workspace_id || "default_workspace",
      ctx.team_id || "default_team",
    ].join(":");

    let user_id;

    // Scope-specific user_id for isolation with full tenant hierarchy
    switch (scope) {
      case "customer":
        user_id = `${tenantPrefix}:customer:${metadata.customer_id || ctx.customer_id}`;
        break;
      case "agent":
        user_id = `${tenantPrefix}:agent:${metadata.agent_id || ctx.agent_id}`;
        break;
      case "team":
        user_id = `${tenantPrefix}:team:${metadata.team_id || ctx.team_id}`;
        break;
      case "organization":
        user_id = `${tenantPrefix}:org`;
        break;
      default:
        user_id = `${tenantPrefix}:agent:${ctx.agent_id}`;
    }

    const messages = [{ role: "user", content }];

    try {
      // Pass messages as first arg, and options (user_id, metadata) as second
      const result = await this.client.add(messages, {
        user_id: user_id,
        metadata: {
          org_id: ctx.org_id,
          workspace_id: ctx.workspace_id,
          team_id: ctx.team_id,
          channel: ctx.channel,
          scope: scope,
          ...metadata,
        },
      });
      return { ok: true, result };
    } catch (error) {
      console.error("Mem0 Add Error:", error);
      return { ok: false, error: String(error) };
    }
  }

  async searchMemory(query, scopes = ["customer", "agent", "team", "organization"]) {
    if (!this.client) return [];

    const ctx = getOrgContext();

    // Build tenant hierarchy prefix: org:workspace:team
    const tenantPrefix = [
      ctx.org_id,
      ctx.workspace_id || "default_workspace",
      ctx.team_id || "default_team",
    ].join(":");

    const results = [];

    for (const scope of scopes) {
      let userId;
      switch (scope) {
        case "customer":
          userId = `${tenantPrefix}:customer:${ctx.customer_id}`;
          break;
        case "agent":
          userId = `${tenantPrefix}:agent:${ctx.agent_id}`;
          break;
        case "team":
          userId = `${tenantPrefix}:team:${ctx.team_id}`;
          break;
        case "organization":
          userId = `${tenantPrefix}:org`;
          break;
      }

      try {
        if (userId) {
          const scopeResults = await this.client.search(query, {
            user_id: userId,
            limit: 3,
          });
          results.push(
            ...scopeResults.map((r) => ({
              ...r,
              scope,
              // Higher weight for more specific scopes
              weight: { customer: 1.0, agent: 0.8, team: 0.6, organization: 0.4 }[scope] || 0.5,
            })),
          );
        }
      } catch (error) {
        console.error(`Mem0 Search Error (${scope}):`, error);
      }
    }

    // Sort by weighted score
    return results.sort((a, b) => b.score * b.weight - a.score * a.weight);
  }
}

const memory = new Mem0Integration();

export default {
  id: "mem0-memory",
  name: "Mem0 Memory",
  description: "Long-term memory storage and retrieval using Mem0.",
  register(api) {
    api.registerTool({
      name: "mem0_add",
      description:
        "Add a memory to the system with a specific scope (customer, agent, team, organization).",
      schema: z.object({
        content: z.string().describe("The text content of the memory to store"),
        scope: z
          .enum(["customer", "agent", "team", "organization"])
          .describe("The scope level of the memory"),
        metadata: z.record(z.any()).optional().describe("Additional metadata keys"),
      }),
      func: async (args) => {
        return await memory.addMemory(args.content, args.scope, args.metadata);
      },
    });

    api.registerTool({
      name: "mem0_search",
      description: "Search for stored memories across specified scopes.",
      schema: z.object({
        query: z.string().describe("The search query"),
        scopes: z
          .array(z.enum(["customer", "agent", "team", "organization"]))
          .optional()
          .default(["customer", "agent", "team", "organization"])
          .describe("Scopes to search in"),
      }),
      func: async (args) => {
        return await memory.searchMemory(args.query, args.scopes);
      },
    });
  },
};

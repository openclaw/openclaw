/**
 * Integration Tools — Enterprise connectors for Stripe, QuickBooks, Salesforce, etc.
 *
 * These tools provide a standardized interface for agents to interact with external services.
 * Actual API calls are delegated to configured webhooks or direct HTTP — agents don't need
 * to know the implementation details.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";

async function readJson(p: string) {
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return null;
  }
}
async function writeJson(p: string, d: any) {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(d, null, 2), "utf-8");
}

type IntegrationConfig = {
  id: string;
  type: string;
  name: string;
  api_key?: string;
  base_url?: string;
  webhook_url?: string;
  enabled: boolean;
  last_sync?: string;
  metadata?: Record<string, unknown>;
};

function integrationsPath(api: OpenClawPluginApi, bizId: string) {
  return join(resolveWorkspaceDir(api), "businesses", bizId, "integrations.json");
}

async function httpRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: any,
): Promise<{ status: number; data: any }> {
  try {
    const resp = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => resp.text());
    return { status: resp.status, data };
  } catch (err) {
    return { status: 0, data: { error: String(err) } };
  }
}

async function refreshGoogleToken(integration: IntegrationConfig): Promise<string | null> {
  const meta = (integration.metadata || {}) as Record<string, unknown>;
  const refreshToken = typeof meta.refresh_token === "string" ? meta.refresh_token : null;
  const clientId = typeof meta.oauth_client_id === "string" ? meta.oauth_client_id : null;
  const clientSecret =
    typeof meta.oauth_client_secret === "string" ? meta.oauth_client_secret : null;
  if (!refreshToken || !clientId || !clientSecret) return null;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  try {
    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const data = await resp.json();
    if (data.access_token) {
      meta.access_token = data.access_token;
      meta.expires_in = data.expires_in ?? 3600;
      return data.access_token;
    }
  } catch {
    /* refresh failed */
  }
  return null;
}

const IntegrationSetupParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  integration_id: Type.String({ description: "Integration ID (e.g., 'stripe-main')" }),
  type: Type.Union(
    [
      Type.Literal("stripe"),
      Type.Literal("quickbooks"),
      Type.Literal("salesforce"),
      Type.Literal("slack"),
      Type.Literal("github"),
      Type.Literal("google-workspace"),
      Type.Literal("hubspot"),
      Type.Literal("xero"),
      Type.Literal("shopify"),
      Type.Literal("webhook"),
      Type.Literal("custom"),
    ],
    { description: "Integration type" },
  ),
  name: Type.String({ description: "Display name" }),
  api_key: Type.Optional(Type.String({ description: "API key or token" })),
  base_url: Type.Optional(Type.String({ description: "Base URL for API calls" })),
  webhook_url: Type.Optional(Type.String({ description: "Webhook URL for events" })),
  metadata: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Additional configuration" }),
  ),
});

const IntegrationSyncParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  integration_id: Type.String({ description: "Integration ID" }),
  sync_type: Type.Union([Type.Literal("full"), Type.Literal("incremental"), Type.Literal("test")], {
    description: "Sync type",
  }),
  entity: Type.Optional(
    Type.String({ description: "Specific entity to sync (e.g., 'invoices', 'customers')" }),
  ),
  since: Type.Optional(Type.String({ description: "Sync data since (ISO date)" })),
});

const IntegrationCallParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  integration_id: Type.String({ description: "Integration ID" }),
  endpoint: Type.String({ description: "API endpoint path (e.g., '/v1/charges')" }),
  method: Type.Optional(
    Type.Union(
      [Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"), Type.Literal("DELETE")],
      { description: "HTTP method (default: GET)" },
    ),
  ),
  params: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), { description: "Request parameters or body" }),
  ),
});

const IntegrationListParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
});

const WebhookReceiveParams = Type.Object({
  business_id: Type.String({ description: "Business ID" }),
  integration_id: Type.String({ description: "Source integration" }),
  event_type: Type.String({
    description: "Event type (e.g., 'payment.received', 'customer.created')",
  }),
  payload: Type.Record(Type.String(), Type.Unknown(), { description: "Event payload" }),
});

export function createIntegrationTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "integration_setup",
      label: "Setup Integration",
      description:
        "Configure an integration with an external service (Stripe, QuickBooks, Salesforce, etc.).",
      parameters: IntegrationSetupParams,
      async execute(_id: string, params: Static<typeof IntegrationSetupParams>) {
        const path = integrationsPath(api, params.business_id);
        const store = (await readJson(path)) || { integrations: [] };

        const existing = store.integrations.findIndex(
          (i: IntegrationConfig) => i.id === params.integration_id,
        );
        const config: IntegrationConfig = {
          id: params.integration_id,
          type: params.type,
          name: params.name,
          api_key: params.api_key,
          base_url: params.base_url || getDefaultBaseUrl(params.type),
          webhook_url: params.webhook_url,
          enabled: true,
          metadata: params.metadata,
        };

        if (existing !== -1) {
          store.integrations[existing] = config;
        } else {
          store.integrations.push(config);
        }

        await writeJson(path, store);
        return textResult(`Integration ${params.integration_id} (${params.type}) configured for ${params.business_id}.
- Base URL: ${config.base_url || "none"}
- Webhook: ${config.webhook_url || "none"}
- API Key: ${config.api_key ? "configured" : "not set"}`);
      },
    },

    {
      name: "integration_list",
      label: "List Integrations",
      description: "List all configured integrations for a business.",
      parameters: IntegrationListParams,
      async execute(_id: string, params: Static<typeof IntegrationListParams>) {
        const store = (await readJson(integrationsPath(api, params.business_id))) || {
          integrations: [],
        };
        const integrations = store.integrations as IntegrationConfig[];

        if (integrations.length === 0) return textResult("No integrations configured.");

        const output = integrations
          .map((i) => {
            const icon = i.enabled ? "✅" : "⏸️";
            return `${icon} **${i.id}** (${i.type}) — ${i.name}${i.last_sync ? ` | Last sync: ${i.last_sync}` : ""}`;
          })
          .join("\n");

        return textResult(`## Integrations — ${params.business_id}\n\n${output}`);
      },
    },

    {
      name: "integration_sync",
      label: "Sync Integration",
      description:
        "Trigger a data sync with an external service. Pulls data and stores as facts/metrics.",
      parameters: IntegrationSyncParams,
      async execute(_id: string, params: Static<typeof IntegrationSyncParams>) {
        const store = (await readJson(integrationsPath(api, params.business_id))) || {
          integrations: [],
        };
        const integration = (store.integrations as IntegrationConfig[]).find(
          (i) => i.id === params.integration_id,
        );

        if (!integration) return textResult(`Integration '${params.integration_id}' not found.`);
        if (!integration.enabled)
          return textResult(`Integration '${params.integration_id}' is disabled.`);

        if (params.sync_type === "test") {
          // Test connectivity
          if (integration.base_url && integration.api_key) {
            const result = await httpRequest(integration.base_url, "GET", {
              Authorization: `Bearer ${integration.api_key}`,
            });
            return textResult(
              `Connection test for ${params.integration_id}: ${result.status === 200 || result.status === 401 ? "✅ Reachable" : `❌ Status ${result.status}`}`,
            );
          }
          return textResult(`Cannot test — no base_url or api_key configured.`);
        }

        // For real syncs, record the intent and provide instructions
        integration.last_sync = new Date().toISOString();
        await writeJson(integrationsPath(api, params.business_id), store);

        return textResult(`## Sync: ${params.integration_id} (${params.sync_type})

**Type:** ${integration.type}
${params.entity ? `**Entity:** ${params.entity}` : "**Entity:** all"}
${params.since ? `**Since:** ${params.since}` : ""}

**Instructions:**
${getSyncInstructions(integration.type, params.entity)}

After receiving data, use \`fact_assert\` to store facts and \`metrics_record\` for metrics.`);
      },
    },

    {
      name: "integration_call",
      label: "API Call",
      description: "Make a direct API call to an integrated service.",
      parameters: IntegrationCallParams,
      async execute(_id: string, params: Static<typeof IntegrationCallParams>) {
        const store = (await readJson(integrationsPath(api, params.business_id))) || {
          integrations: [],
        };
        const integration = (store.integrations as IntegrationConfig[]).find(
          (i) => i.id === params.integration_id,
        );

        if (!integration) return textResult(`Integration '${params.integration_id}' not found.`);
        if (!integration.base_url)
          return textResult(`No base URL configured for '${params.integration_id}'.`);

        const url = `${integration.base_url}${params.endpoint}`;
        const method = params.method || "GET";
        const headers: Record<string, string> = {};

        // Resolve the best auth token: prefer OAuth2 access_token from metadata,
        // then fall back to api_key.
        const meta = (integration.metadata || {}) as Record<string, unknown>;
        const oauthToken = typeof meta.access_token === "string" ? meta.access_token : null;
        const authToken = oauthToken || integration.api_key;

        if (authToken) {
          if (integration.type === "google-workspace" && oauthToken) {
            // Google APIs need the OAuth2 access token, and may need refresh.
            headers["Authorization"] = `Bearer ${oauthToken}`;
          } else if (integration.type === "shopify") {
            headers["X-Shopify-Access-Token"] = authToken;
          } else {
            headers["Authorization"] = `Bearer ${authToken}`;
          }
        }

        let result = await httpRequest(url, method, headers, params.params);

        // Auto-refresh Google OAuth2 token on 401 and retry once.
        if (result.status === 401 && integration.type === "google-workspace") {
          const newToken = await refreshGoogleToken(integration);
          if (newToken) {
            headers["Authorization"] = `Bearer ${newToken}`;
            result = await httpRequest(url, method, headers, params.params);
            // Persist the refreshed token
            await writeJson(integrationsPath(api, params.business_id), store);
          }
        }

        return textResult(`## API Response: ${method} ${params.endpoint}

**Status:** ${result.status}
**Data:**
\`\`\`json
${JSON.stringify(result.data, null, 2).slice(0, 3000)}
\`\`\``);
      },
    },

    {
      name: "webhook_process",
      label: "Process Webhook Event",
      description:
        "Process an incoming webhook event from an integration. Routes to appropriate agent and stores as facts.",
      parameters: WebhookReceiveParams,
      async execute(_id: string, params: Static<typeof WebhookReceiveParams>) {
        const ws = resolveWorkspaceDir(api);
        const now = new Date().toISOString();

        // Log the event
        const eventLogPath = join(ws, "businesses", params.business_id, "webhook-events.json");
        const log = (await readJson(eventLogPath)) || { events: [] };
        log.events.push({
          integration: params.integration_id,
          type: params.event_type,
          payload: params.payload,
          received_at: now,
          processed: false,
        });
        // Keep last 1000 events
        if (log.events.length > 1000) log.events = log.events.slice(-1000);
        await writeJson(eventLogPath, log);

        // Route to appropriate agent
        const routing = routeWebhookEvent(params.event_type);

        // Send to agent inbox
        if (routing.agent) {
          const inboxPath = join(
            ws,
            "businesses",
            params.business_id,
            "agents",
            routing.agent,
            "inbox.json",
          );
          const inbox = (await readJson(inboxPath)) || [];
          inbox.push({
            id: `WH-${Date.now().toString(36)}`,
            from: `integration:${params.integration_id}`,
            to: routing.agent,
            performative: "INFORM",
            content: `Webhook: ${params.event_type}\n${JSON.stringify(params.payload, null, 2).slice(0, 500)}`,
            priority: routing.priority,
            timestamp: now,
            read: false,
          });
          await writeJson(inboxPath, inbox);
        }

        return textResult(
          `Webhook processed: ${params.event_type} → ${routing.agent || "unrouted"} (${routing.priority})`,
        );
      },
    },
  ];
}

function getDefaultBaseUrl(type: string): string {
  const urls: Record<string, string> = {
    stripe: "https://api.stripe.com",
    quickbooks: "https://quickbooks.api.intuit.com",
    salesforce: "https://login.salesforce.com",
    hubspot: "https://api.hubapi.com",
    xero: "https://api.xero.com",
    shopify: "", // Requires store URL
    github: "https://api.github.com",
    "google-workspace": "https://www.googleapis.com",
  };
  return urls[type] || "";
}

function getSyncInstructions(type: string, entity?: string): string {
  const instructions: Record<string, string> = {
    stripe: `Use integration_call with:
- /v1/charges — recent payments
- /v1/customers — customer list
- /v1/invoices — invoice data
- /v1/balance — current balance`,
    quickbooks: `Use integration_call with:
- /v3/company/{id}/query — run queries
- Entities: Invoice, Payment, Customer, Vendor, Account`,
    salesforce: `Use integration_call with:
- /services/data/v58.0/query — SOQL queries
- Entities: Account, Contact, Opportunity, Lead`,
    shopify: `Use integration_call with:
- /admin/api/2024-01/orders.json
- /admin/api/2024-01/products.json
- /admin/api/2024-01/customers.json`,
    "google-workspace": `Use integration_call with:
- /drive/v3/files — list Drive files
- /drive/v3/files/{fileId} — get file metadata
- /drive/v3/files/{fileId}/export — export Google Docs/Sheets
- /v4/spreadsheets/{id} — read spreadsheet
- /gmail/v1/users/me/messages — list emails`,
  };
  return instructions[type] || "Use integration_call to fetch data from the configured endpoint.";
}

function routeWebhookEvent(eventType: string): { agent: string; priority: string } {
  const lower = eventType.toLowerCase();
  if (
    lower.includes("payment") ||
    lower.includes("invoice") ||
    lower.includes("charge") ||
    lower.includes("refund")
  ) {
    return { agent: "cfo", priority: lower.includes("fail") ? "urgent" : "normal" };
  }
  if (lower.includes("customer") || lower.includes("lead") || lower.includes("subscriber")) {
    return { agent: "cmo", priority: "normal" };
  }
  if (lower.includes("order") || lower.includes("fulfillment") || lower.includes("shipping")) {
    return { agent: "coo", priority: "high" };
  }
  if (lower.includes("deploy") || lower.includes("incident") || lower.includes("alert")) {
    return { agent: "cto", priority: lower.includes("incident") ? "urgent" : "normal" };
  }
  if (lower.includes("contract") || lower.includes("legal") || lower.includes("compliance")) {
    return { agent: "legal", priority: "high" };
  }
  return { agent: "ceo", priority: "normal" };
}

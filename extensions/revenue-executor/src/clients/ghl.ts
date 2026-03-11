import type { GhlClient } from "../types.js";

type Env = NodeJS.ProcessEnv;

function requireEnv(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function parseJsonSafe(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requestJson(params: {
  baseUrl: string;
  apiKey: string;
  path: string;
  method?: string;
  body?: Record<string, unknown>;
}): Promise<unknown> {
  const response = await fetch(`${params.baseUrl}${params.path}`, {
    method: params.method ?? "GET",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });

  const payload = await parseJsonSafe(response);
  if (!response.ok) {
    const details = typeof payload === "object" && payload ? JSON.stringify(payload) : "";
    throw new Error(`GHL request failed (${response.status}) ${details}`.trim());
  }

  return payload;
}

export function createGhlClient(env: Env = process.env): GhlClient {
  const baseUrl = trimTrailingSlash(
    env.OPENCLAW_REVENUE_GHL_BASE_URL?.trim() || "https://services.leadconnectorhq.com",
  );
  const apiKey = requireEnv(env, "OPENCLAW_REVENUE_GHL_API_KEY");

  const searchPath = env.OPENCLAW_REVENUE_GHL_CONTACT_SEARCH_PATH?.trim() || "/contacts/search";
  const createContactPath =
    env.OPENCLAW_REVENUE_GHL_CONTACT_CREATE_PATH?.trim() || "/contacts";
  const createOpportunityPath =
    env.OPENCLAW_REVENUE_GHL_OPPORTUNITY_CREATE_PATH?.trim() || "/opportunities";

  return {
    async checkContact({ name, email, phone }) {
      const payload = await requestJson({
        baseUrl,
        apiKey,
        path: searchPath,
        method: "POST",
        body: {
          name,
          email,
          phone,
          query: email || phone || name,
        },
      });

      const contacts =
        (payload as { contacts?: Array<{ id?: string; name?: string; email?: string; phone?: string }> })
          .contacts ?? [];

      const first = contacts.find((item) => typeof item?.id === "string" && item.id.length > 0);
      if (!first?.id) {
        return null;
      }

      return {
        id: first.id,
        name: first.name,
        email: first.email,
        phone: first.phone,
      };
    },

    async createContact({ name, email, phone }) {
      const payload = await requestJson({
        baseUrl,
        apiKey,
        path: createContactPath,
        method: "POST",
        body: { name, email, phone },
      });

      const id = (payload as { contact?: { id?: string }; id?: string }).contact?.id ||
        (payload as { id?: string }).id;
      if (!id) {
        throw new Error("GHL createContact response missing id");
      }
      return { id };
    },

    async createOpportunity({ contactId, name, amount, locationId }) {
      const payload = await requestJson({
        baseUrl,
        apiKey,
        path: createOpportunityPath,
        method: "POST",
        body: {
          contactId,
          name,
          amount,
          locationId,
        },
      });

      const id = (payload as { opportunity?: { id?: string }; id?: string }).opportunity?.id ||
        (payload as { id?: string }).id;
      if (!id) {
        throw new Error("GHL createOpportunity response missing id");
      }
      return { id };
    },
  };
}

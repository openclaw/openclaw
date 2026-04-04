import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";

export const id = "apollo-enrichment";

const DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
const ENRICHMENT_BASE_PATH = "/v1/enrichment";
const APOLLO_ACTIONS = ["people", "company", "people_search"] as const;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function resolveGatewayUrl(config: unknown): string {
  const root = asRecord(config);
  const pluginEntries = asRecord(asRecord(root?.plugins)?.entries);
  const gatewayConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  return (
    readTrimmedString(gatewayConfig?.gatewayUrl) ||
    process.env.DENCH_GATEWAY_URL?.trim() ||
    DEFAULT_GATEWAY_URL
  );
}

function resolveApiKey(config: unknown): string | undefined {
  const root = asRecord(config);
  const providers = asRecord(asRecord(asRecord(root?.models)?.providers));
  const provider = asRecord(providers?.["dench-cloud"]);
  return (
    readTrimmedString(provider?.apiKey) ||
    process.env.DENCH_CLOUD_API_KEY?.trim() ||
    process.env.DENCH_API_KEY?.trim() ||
    undefined
  );
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const ApolloEnrichParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...APOLLO_ACTIONS],
      description: 'Action to perform: "people", "company", or "people_search".',
    },
    email: { type: "string", description: "Email for people enrichment." },
    linkedinUrl: { type: "string", description: "LinkedIn URL for people enrichment." },
    firstName: { type: "string", description: "Person first name." },
    lastName: { type: "string", description: "Person last name." },
    domain: { type: "string", description: "Company domain such as acme.com." },
    organizationName: { type: "string", description: "Organization name hint for people enrichment." },
    personTitles: { type: "array", items: { type: "string" }, description: "Job titles for people search." },
    personLocations: { type: "array", items: { type: "string" }, description: "Locations for people search." },
    organizationDomains: { type: "array", items: { type: "string" }, description: "Organization domains for people search." },
    page: { type: "number", description: "People search page number." },
    perPage: { type: "number", description: "People search page size." },
    first_name: { type: "string", description: "Legacy alias for firstName." },
    last_name: { type: "string", description: "Legacy alias for lastName." },
    organization_name: { type: "string", description: "Legacy alias for organizationName." },
    linkedin_url: { type: "string", description: "Legacy alias for linkedinUrl." },
    person_titles: { type: "array", items: { type: "string" }, description: "Legacy alias for personTitles." },
    person_locations: { type: "array", items: { type: "string" }, description: "Legacy alias for personLocations." },
    organization_domains: { type: "array", items: { type: "string" }, description: "Legacy alias for organizationDomains." },
    per_page: { type: "number", description: "Legacy alias for perPage." },
  },
  required: ["action"],
};

function buildPeopleBody(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const email = readTrimmedString(params.email);
  const linkedinUrl = readTrimmedString(params.linkedinUrl) ?? readTrimmedString(params.linkedin_url);
  const firstName = readTrimmedString(params.firstName) ?? readTrimmedString(params.first_name);
  const lastName = readTrimmedString(params.lastName) ?? readTrimmedString(params.last_name);
  const domain = readTrimmedString(params.domain);
  const organizationName =
    readTrimmedString(params.organizationName) ?? readTrimmedString(params.organization_name);

  if (email) {
    body.email = email;
  }
  if (linkedinUrl) {
    body.linkedinUrl = linkedinUrl;
  }
  if (firstName) {
    body.firstName = firstName;
  }
  if (lastName) {
    body.lastName = lastName;
  }
  if (domain) {
    body.domain = domain;
  }
  if (organizationName) {
    body.organizationName = organizationName;
  }

  return body;
}

function buildPeopleSearchBody(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const personTitles = readStringList(params.personTitles) ?? readStringList(params.person_titles);
  const personLocations =
    readStringList(params.personLocations) ?? readStringList(params.person_locations);
  const organizationDomains =
    readStringList(params.organizationDomains) ?? readStringList(params.organization_domains);
  const page = typeof params.page === "number" ? params.page : undefined;
  const perPage =
    typeof params.perPage === "number"
      ? params.perPage
      : typeof params.per_page === "number"
        ? params.per_page
        : undefined;

  if (personTitles) {
    body.personTitles = personTitles;
  }
  if (personLocations) {
    body.personLocations = personLocations;
  }
  if (organizationDomains) {
    body.organizationDomains = organizationDomains;
  }
  if (page !== undefined) {
    body.page = page;
  }
  if (perPage !== undefined) {
    body.perPage = perPage;
  }

  return body;
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function executeApolloEnrich(
  gatewayUrl: string,
  apiKey: string,
  _toolCallId: string,
  params: Record<string, unknown>,
) {
  const action = params.action;
  if (action !== "people" && action !== "company" && action !== "people_search") {
    return jsonResult({
      error: `Unknown action "${String(action)}". Use "people", "company", or "people_search".`,
    });
  }

  try {
    let response: Response;

    if (action === "people") {
      const body = buildPeopleBody(params);
      if (!body.email && !body.linkedinUrl && !body.firstName && !body.lastName) {
        return jsonResult({
          error:
            "People enrichment requires at least an email, LinkedIn URL, or person name.",
        });
      }
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } else if (action === "company") {
      const domain = readTrimmedString(params.domain);
      if (!domain) {
        return jsonResult({ error: "Company enrichment requires a domain." });
      }
      const url = new URL(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/company`);
      url.searchParams.set("domain", domain);
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
    } else {
      const body = buildPeopleSearchBody(params);
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      const detail = await parseResponse(response).catch(() => "");
      return jsonResult({
        error: `Enrichment request failed (HTTP ${response.status}).`,
        detail: detail || undefined,
      });
    }

    return jsonResult(await parseResponse(response));
  } catch (err) {
    return jsonResult({
      error: "Enrichment request failed.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export default function register(api: OpenClawPluginApi) {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const gatewayUrl = resolveGatewayUrl(api.config);
  const apiKey = resolveApiKey(api.config);

  if (!apiKey) {
    api.logger?.info?.(
      "[apollo-enrichment] No Dench Cloud API key found; tool will not be registered.",
    );
    return;
  }

  api.registerTool({
    name: "apollo_enrich",
    label: "Apollo Enrichment",
    description:
      "Look up Apollo people, companies, or people search results through the Dench Cloud gateway. " +
      'Use action "people" for an individual profile, "company" for company enrichment by domain, ' +
      'or "people_search" to search people with filters such as titles, locations, and company domains.',
    parameters: ApolloEnrichParameters,
    execute: (toolCallId: string, params: Record<string, unknown>) =>
      executeApolloEnrich(gatewayUrl, apiKey, toolCallId, params),
  } as AnyAgentTool);
}

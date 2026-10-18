import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import crmPlugin from "../index.js";

type CallableTool = {
  name: string;
  resultContentSource?: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
};

const EXPECTED_TOOLS = [
  "crm_search",
  "crm_list_records",
  "crm_get_record",
  "crm_create_record",
  "crm_update_record",
  "crm_log_activity",
  "crm_timeline",
  "crm_my_tasks",
  "crm_complete_activity",
];

function testConfig(): OpenClawConfig {
  return {
    plugins: {
      entries: {
        crm: {
          config: {
            baseUrl: "http://crm.test:3001",
            apiKey: "crm-key",
          },
        },
      },
    },
  } as OpenClawConfig;
}

function registerTools(): Map<string, CallableTool> {
  const tools = new Map<string, CallableTool>();
  const api = createTestPluginApi({
    config: testConfig(),
    registerTool(tool, opts) {
      if (opts?.name && typeof tool !== "function" && !Array.isArray(tool)) {
        tools.set(opts.name, tool as unknown as CallableTool);
      }
    },
  });
  crmPlugin.register(api);
  return tools;
}

function getTool(tools: Map<string, CallableTool>, name: string): CallableTool {
  const tool = tools.get(name);
  if (!tool) {
    throw new Error(`Missing tool ${name}`);
  }
  return tool;
}

function mockJson(payload: unknown, status = 200) {
  // Return a fresh Response per call: a Response body can only be read once.
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(payload, { status }));
}

function requestBody(fetchMock: ReturnType<typeof mockJson>, index: number): unknown {
  const body = fetchMock.mock.calls[index]?.[1]?.body;
  return typeof body === "string" ? JSON.parse(body) : undefined;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("crm tools", () => {
  it("registers every declared tool as network-backed", () => {
    const tools = registerTools();

    expect([...tools.keys()]).toEqual(EXPECTED_TOOLS);
    for (const tool of tools.values()) {
      expect(tool.resultContentSource).toBe("network");
    }
  });

  it("searches and lists records through the REST bridge", async () => {
    const fetchMock = mockJson({ rows: [], total: 0, facetCounts: {} });
    const tools = registerTools();

    await getTool(tools, "crm_search").execute("search", { query: "acme" });
    await getTool(tools, "crm_list_records").execute("list", {
      entity: "contact",
      query: "ada",
      page: 2,
      pageSize: 10,
      filters: { owner: ["user-1"], activity: ["30"] },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://crm.test:3001/rest/search?q=acme");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://crm.test:3001/rest/contacts/search");
    expect(requestBody(fetchMock, 1)).toEqual({
      q: "ada",
      page: 2,
      pageSize: 10,
      owner: ["user-1"],
      activity: ["30"],
    });
  });

  it("rejects unsupported list filters before calling the API", async () => {
    const fetchMock = mockJson({ rows: [] });
    const tools = registerTools();

    await expect(
      getTool(tools, "crm_list_records").execute("list", {
        entity: "deal",
        filters: { industry: ["software"] },
      }),
    ).rejects.toThrow("filters.industry is not supported for deals");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates required create fields", async () => {
    const fetchMock = mockJson({ id: "contact-1" });
    const tools = registerTools();

    await expect(
      getTool(tools, "crm_create_record").execute("create", {
        entity: "contact",
        data: { lastName: "Lovelace" },
      }),
    ).rejects.toThrow("contact data.firstName is required.");
    await expect(
      getTool(tools, "crm_create_record").execute("create", {
        entity: "deal",
        data: { name: "Renewal", companyId: "company-1" },
      }),
    ).rejects.toThrow("deal data.ownerId is required.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a deal with the CRM field names unchanged", async () => {
    const fetchMock = mockJson({ id: "deal-1" });
    const tools = registerTools();

    await getTool(tools, "crm_create_record").execute("create", {
      entity: "deal",
      data: {
        name: "Renewal",
        companyId: "company-1",
        ownerId: "user-1",
        stage: "QUALIFIED_TO_BUY",
        amountCents: 125_000,
        currency: "USD",
      },
    });

    expect(requestBody(fetchMock, 0)).toEqual({
      name: "Renewal",
      companyId: "company-1",
      ownerId: "user-1",
      stage: "QUALIFIED_TO_BUY",
      amountCents: 125_000,
      currency: "USD",
    });
  });

  it("routes deal stage updates through the stage endpoint", async () => {
    const fetchMock = mockJson({ changed: true });
    const tools = registerTools();

    await getTool(tools, "crm_update_record").execute("update", {
      entity: "deal",
      id: "deal-1",
      data: { stage: "CLOSED_LOST", closedReason: "Budget" },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://crm.test:3001/rest/deals/deal-1/stage");
    expect(requestBody(fetchMock, 0)).toEqual({
      stage: "CLOSED_LOST",
      closedReason: "Budget",
    });
  });

  it("wraps contact updates in the REST bridge data field", async () => {
    const fetchMock = mockJson({ id: "contact-1" });
    const tools = registerTools();

    await getTool(tools, "crm_update_record").execute("update", {
      entity: "contact",
      id: "contact-1",
      data: { title: "CTO" },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://crm.test:3001/rest/contacts/contact-1");
    expect(requestBody(fetchMock, 0)).toEqual({
      data: { title: "CTO" },
    });
  });

  it("maps activity types to the CRM enum and enforces task subjects", async () => {
    const fetchMock = mockJson({ id: "activity-1" });
    const tools = registerTools();

    await getTool(tools, "crm_log_activity").execute("log", {
      type: "note",
      body: "Called about renewal",
      companyId: "company-1",
    });

    expect(requestBody(fetchMock, 0)).toEqual({
      type: "NOTE",
      body: "Called about renewal",
      companyId: "company-1",
    });

    await expect(
      getTool(tools, "crm_log_activity").execute("log", {
        type: "task",
        companyId: "company-1",
      }),
    ).rejects.toThrow("A task needs a subject.");
  });

  it("requires exactly one timeline anchor", async () => {
    const fetchMock = mockJson({ entries: [], nextCursor: null });
    const tools = registerTools();

    await expect(
      getTool(tools, "crm_timeline").execute("timeline", {
        companyId: "company-1",
        dealId: "deal-1",
      }),
    ).rejects.toThrow("Provide exactly one of companyId, contactId, or dealId.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("completes activities by default", async () => {
    const fetchMock = mockJson({ id: "activity-1" });
    const tools = registerTools();

    await getTool(tools, "crm_complete_activity").execute("complete", {
      id: "activity-1",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://crm.test:3001/rest/activities/activity-1/complete",
    );
    expect(requestBody(fetchMock, 0)).toEqual({
      completed: true,
    });
  });
});

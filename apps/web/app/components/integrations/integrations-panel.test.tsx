// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntegrationsPanel } from "./integrations-panel";

const eligiblePayload = {
  denchCloud: {
    hasKey: true,
    isPrimaryProvider: true,
    primaryModel: "dench-cloud/anthropic.claude-opus-4-6-v1",
  },
  metadata: { schemaVersion: 1 },
  search: { builtIn: { enabled: false, denied: true, provider: "duckduckgo" }, effectiveOwner: "exa" },
  integrations: [],
};

const toolkitsPayload = {
  items: [
    {
      slug: "gmail",
      name: "Gmail",
      description: "Read and send email",
      logo: null,
      categories: ["Email"],
      auth_schemes: ["oauth2"],
      tools_count: 4,
    },
  ],
  cursor: null,
  total: 1,
  categories: ["Email"],
};

const connectionsPayload = { connections: [] };

const statusPayload = {
  summary: { level: "healthy", verified: true, message: "Dench Integrations is healthy." },
  config: { status: "pass", detail: "OK." },
  gatewayTools: { status: "pass", detail: "OK.", toolCount: 4 },
  liveAgent: { status: "pass", detail: "OK.", evidence: [] },
};

describe("IntegrationsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch() {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url === "/api/integrations") return new Response(JSON.stringify(eligiblePayload));
      if (url === "/api/composio/connections?include_toolkits=1") {
        return new Response(JSON.stringify({ ...connectionsPayload, toolkits: [] }));
      }
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({ ...connectionsPayload, toolkits: [] }));
      }
      if (url === "/api/composio/status") return new Response(JSON.stringify(statusPayload));
      if (url.startsWith("/api/composio/toolkits")) {
        return new Response(JSON.stringify(toolkitsPayload));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  }

  it("renders the integrations heading and shows unified sections", async () => {
    mockFetch();

    render(<IntegrationsPanel />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Composio" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Discover")).toBeInTheDocument();
    });
  });

  it("shows marketplace apps in the Discover section", async () => {
    mockFetch();

    render(<IntegrationsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });
  });

  it("shows Dench Cloud lock badge when not eligible", async () => {
    const lockedPayload = {
      ...eligiblePayload,
      denchCloud: {
        hasKey: false,
        isPrimaryProvider: false,
        primaryModel: "anthropic/claude-4",
      },
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      if (url === "/api/integrations") return new Response(JSON.stringify(lockedPayload));
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(<IntegrationsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Available with Dench Cloud")).toBeInTheDocument();
    });

    expect(screen.getByText("Get Dench Cloud API Key")).toBeInTheDocument();
  });
});

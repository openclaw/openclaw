// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposioAppsSection } from "./composio-apps-section";
import { extractComposioToolkits } from "@/lib/composio-client";

const gmailToolkit = {
  slug: "gmail",
  name: "Gmail",
  description: "Read and send email",
  logo: null,
  categories: ["Email"],
  auth_schemes: ["oauth2"],
  tools_count: 4,
};

const githubToolkit = {
  slug: "github",
  name: "GitHub",
  description: "Work with repositories",
  logo: null,
  categories: ["Developer tools"],
  auth_schemes: ["oauth2"],
  tools_count: 6,
};

const notionToolkit = {
  slug: "notion",
  name: "Notion",
  description: "Search docs and databases",
  logo: null,
  categories: ["Knowledge"],
  auth_schemes: ["oauth2"],
  tools_count: 3,
};

const slackToolkit = {
  slug: "slack",
  name: "Slack",
  description: "Send messages to channels",
  logo: null,
  categories: ["Communication"],
  auth_schemes: ["oauth2"],
  tools_count: 5,
};

const marketplacePageOne = {
  items: [notionToolkit],
  cursor: "page-2",
  total: 2,
  categories: ["Knowledge", "Communication", "Email"],
};

const marketplacePageTwo = {
  items: [slackToolkit],
  cursor: null,
  total: 2,
  categories: ["Knowledge", "Communication", "Email"],
};

const connectionsPayload = {
  connections: [
    {
      id: "ca_gmail_1",
      toolkit_slug: "gmail",
      toolkit_name: "Gmail",
      status: "ACTIVE",
      created_at: "2026-04-01T00:00:00.000Z",
      account_label: "Work Gmail",
      account_stable_id: "cmpacct_gmail_work",
      account: {
        stableId: "cmpacct_gmail_work",
        confidence: "high",
        label: "Work Gmail",
      },
      reconnect: {
        claim: "same",
        confidence: "high",
        relatedConnectionIds: ["ca_gmail_2"],
      },
    },
    {
      id: "ca_gmail_2",
      toolkit_slug: "gmail",
      toolkit_name: "Gmail",
      status: "ACTIVE",
      created_at: "2026-04-02T00:00:00.000Z",
      account_label: "Personal Gmail",
      account_stable_id: "cmpacct_gmail_work",
      account: {
        stableId: "cmpacct_gmail_work",
        confidence: "high",
        label: "Personal Gmail",
      },
      reconnect: {
        claim: "same",
        confidence: "high",
        relatedConnectionIds: ["ca_gmail_1"],
      },
    },
    {
      id: "ca_github_1",
      toolkit_slug: "github",
      toolkit_name: "GitHub",
      status: "ACTIVE",
      created_at: "2026-04-03T00:00:00.000Z",
      account_label: "GitHub",
      account_stable_id: "cmpacct_github",
      account: {
        stableId: "cmpacct_github",
        confidence: "high",
        label: "GitHub",
      },
    },
  ],
};

const statusPayload: {
  summary: {
    level: "healthy" | "warning" | "error";
    verified: boolean;
    message: string;
  };
  config: {
    status: "pass" | "fail" | "unknown";
    detail: string;
  };
  gatewayTools: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    toolCount: number;
  };
  liveAgent: {
    status: "pass" | "fail" | "unknown";
    detail: string;
    evidence: string[];
  };
} = {
  summary: {
    level: "healthy" as const,
    verified: true,
    message: "Composio MCP is healthy.",
  },
  config: {
    status: "pass" as const,
    detail: "Config OK.",
  },
  gatewayTools: {
    status: "pass" as const,
    detail: "OK.",
    toolCount: 24,
  },
  liveAgent: {
    status: "pass" as const,
    detail: "Agent verified.",
    evidence: [],
  },
};

let intersectionHandler: IntersectionObserverCallback | null = null;

function installFetchMock(statusOverride = statusPayload) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url === "/api/composio/connections") {
      return new Response(JSON.stringify(connectionsPayload));
    }

    if (url === "/api/composio/status") {
      return new Response(JSON.stringify(statusOverride));
    }

    if (url.startsWith("/api/composio/toolkits")) {
      const parsed = new URL(url, "http://localhost");
      const search = parsed.searchParams.get("search");
      const cursor = parsed.searchParams.get("cursor");

      if (search === "gmail") {
        return new Response(JSON.stringify({ items: [gmailToolkit], cursor: null, total: 1, categories: ["Email"] }));
      }

      if (search === "github") {
        return new Response(JSON.stringify({ items: [githubToolkit], cursor: null, total: 1, categories: ["Developer tools"] }));
      }

      if (cursor === "page-2") {
        return new Response(JSON.stringify(marketplacePageTwo));
      }

      return new Response(JSON.stringify(marketplacePageOne));
    }

    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

describe("ComposioAppsSection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    intersectionHandler = null;
    global.IntersectionObserver = class MockIntersectionObserver implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];

      constructor(callback: IntersectionObserverCallback) {
        intersectionHandler = callback;
      }

      disconnect() {}
      observe() {}
      takeRecords() { return []; }
      unobserve() {}
    };
    installFetchMock();
  });

  it("shows connected apps in the Connected tab and paged apps in Marketplace", async () => {
    const user = userEvent.setup();
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Marketplace" }));

    await waitFor(() => {
      expect(screen.getByText("Notion")).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Knowledge" })).toBeInTheDocument();

    intersectionHandler?.(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );

    await waitFor(() => {
      expect(screen.getByText("Slack")).toBeInTheDocument();
    });
  });

  it("opens a toolkit modal with multi-account management details", async () => {
    const user = userEvent.setup();
    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("Gmail")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Manage Gmail" }));

    expect(screen.getByRole("heading", { name: "Gmail" })).toBeInTheDocument();
    expect(screen.getByText("Connections")).toBeInTheDocument();
    expect(screen.getByText("Personal Gmail")).toBeInTheDocument();
    expect(screen.getByText("Work Gmail")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect another account" })).toBeInTheDocument();
  });

  it("shows MCP repair bar when status is unhealthy", async () => {
    const warningStatus = {
      ...statusPayload,
      summary: {
        level: "warning" as const,
        verified: false,
        message: "Composio MCP verification was inconclusive: Live agent probe timed out before returning a result.",
      },
      liveAgent: {
        status: "unknown" as const,
        detail: "Live agent probe timed out before returning a result.",
        evidence: ["GMAIL_FETCH_EMAILS"],
      },
    };
    installFetchMock(warningStatus);

    render(<ComposioAppsSection eligible lockBadge={null} />);

    await waitFor(() => {
      expect(screen.getByText("Composio MCP verification was inconclusive: Live agent probe timed out before returning a result.")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Live agent probe timed out before returning a result.").length).toBeGreaterThan(0);
    expect(screen.getByText("Evidence: GMAIL_FETCH_EMAILS")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair" })).toBeInTheDocument();
  });

  it("normalizes toolkit payloads that omit categories", () => {
    const normalized = extractComposioToolkits({
      items: [
        {
          slug: "slack",
          name: "Slack",
          description: "Team chat",
          tools_count: 4,
        },
      ],
    });

    expect(normalized.items[0]).toEqual(
      expect.objectContaining({
        slug: "slack",
        name: "Slack",
        categories: [],
        auth_schemes: [],
      }),
    );
    expect(normalized.categories).toEqual([]);
  });

  it("shows lock badge when not eligible", () => {
    render(<ComposioAppsSection eligible={false} lockBadge="Get Dench Cloud API Key" />);

    expect(screen.getByText("Available with Dench Cloud")).toBeInTheDocument();
    expect(screen.getByText("Get Dench Cloud API Key")).toBeInTheDocument();
  });
});

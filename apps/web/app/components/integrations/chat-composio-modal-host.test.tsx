// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatComposioModalHost } from "./chat-composio-modal-host";

describe("ChatComposioModalHost", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the composio modal directly for assistant connect links", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({ connections: [], toolkits: [] }));
      }
      if (url === "/api/composio/toolkits?search=Slack&limit=24") {
        return new Response(JSON.stringify({
          items: [{
            slug: "slack",
            name: "Slack",
            description: "Messages and channels",
            logo: null,
            categories: ["Communication"],
            auth_schemes: ["oauth2"],
            tools_count: 4,
          }],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const onFallbackToIntegrations = vi.fn();

    render(
      <ChatComposioModalHost
        request={{ action: "connect", toolkitSlug: "slack", toolkitName: "Slack" }}
        onFallbackToIntegrations={onFallbackToIntegrations}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Connect Slack" })).toBeInTheDocument();
    });
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(onFallbackToIntegrations).not.toHaveBeenCalled();
  });

  it("keeps reconnect actions on the direct-open modal path", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/composio/connections?include_toolkits=1&fresh=1") {
        return new Response(JSON.stringify({
          connections: [{
            id: "slack-1",
            toolkit_slug: "slack",
            toolkit_name: "Slack",
            status: "ACTIVE",
            created_at: "2026-04-01T00:00:00.000Z",
          }],
          toolkits: [{
            slug: "slack",
            connect_slug: "slack",
            name: "Slack",
            description: "Messages and channels",
            logo: null,
            categories: ["Communication"],
            auth_schemes: ["oauth2"],
            tools_count: 4,
          }],
        }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    render(
      <ChatComposioModalHost
        request={{ action: "reconnect", toolkitSlug: "slack", toolkitName: "Slack" }}
        onFallbackToIntegrations={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reconnect Slack" })).toBeInTheDocument();
    });
  });

  it("falls back to integrations when the assistant link has no toolkit slug", async () => {
    global.fetch = vi.fn() as typeof fetch;
    const onFallbackToIntegrations = vi.fn();

    render(
      <ChatComposioModalHost
        request={{ action: "connect", toolkitName: "Slack" }}
        onFallbackToIntegrations={onFallbackToIntegrations}
      />,
    );

    await waitFor(() => {
      expect(onFallbackToIntegrations).toHaveBeenCalledTimes(1);
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

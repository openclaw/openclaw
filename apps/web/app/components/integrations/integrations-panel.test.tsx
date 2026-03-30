// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IntegrationsPanel } from "./integrations-panel";

describe("IntegrationsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("renders integrations data from the backend API", async () => {
    const user = userEvent.setup();
    const initialPayload = {
      metadata: {
        schemaVersion: 1,
        exa: {
          ownsSearch: true,
          fallbackProvider: "duckduckgo",
        },
      },
      search: {
        builtIn: {
          enabled: false,
          denied: true,
          provider: "duckduckgo",
        },
        effectiveOwner: "exa",
      },
      integrations: [
        {
          id: "exa",
          label: "Exa Search",
          enabled: true,
          available: true,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: {
            pluginId: "exa-search",
            configured: true,
            enabled: true,
            allowlisted: true,
            loadPathConfigured: true,
            installRecorded: true,
            installPath: "/tmp/exa",
            installPathExists: true,
            sourcePath: "/repo/exa",
          },
          managedByDench: true,
          healthIssues: [],
          health: {
            status: "healthy",
            pluginMissing: false,
            pluginInstalledButDisabled: false,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
        },
        {
          id: "apollo",
          label: "Apollo Enrichment",
          enabled: false,
          available: false,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: {
            pluginId: "apollo-enrichment",
            configured: true,
            enabled: false,
            allowlisted: true,
            loadPathConfigured: true,
            installRecorded: true,
            installPath: "/tmp/apollo",
            installPathExists: true,
            sourcePath: "/repo/apollo",
          },
          managedByDench: true,
          healthIssues: ["plugin_disabled"],
          health: {
            status: "disabled",
            pluginMissing: false,
            pluginInstalledButDisabled: true,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
        },
        {
          id: "elevenlabs",
          label: "ElevenLabs",
          enabled: true,
          available: true,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: null,
          managedByDench: true,
          healthIssues: [],
          health: {
            status: "healthy",
            pluginMissing: false,
            pluginInstalledButDisabled: false,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
          overrideActive: true,
        },
      ],
    };

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      const method = init?.method ?? "GET";
      if (url === "/api/integrations" && method === "GET") {
        return new Response(JSON.stringify(initialPayload));
      }
      if (url === "/api/integrations/apollo/toggle" && method === "POST") {
        return new Response(JSON.stringify({
          integration: "apollo",
          changed: true,
          refresh: {
            attempted: true,
            restarted: true,
            error: null,
            profile: "dench",
          },
          ...initialPayload,
          integrations: initialPayload.integrations.map((integration) =>
            integration.id === "apollo"
              ? {
                ...integration,
                enabled: true,
                available: true,
                healthIssues: [],
                health: {
                  ...integration.health,
                  status: "healthy",
                  pluginInstalledButDisabled: false,
                },
              }
              : integration
          ),
        }));
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }) as typeof fetch;

    render(<IntegrationsPanel />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Search Ownership")).toBeInTheDocument();
    });

    expect(screen.getByText("Exa Search")).toBeInTheDocument();
    expect(screen.getByText("Apollo Enrichment")).toBeInTheDocument();
    expect(screen.getByText("ElevenLabs")).toBeInTheDocument();
    expect(screen.getByText("Dench Exa")).toBeInTheDocument();
    expect(screen.getByText("Plugin is installed but disabled")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Toggle Apollo Enrichment"));

    await waitFor(() => {
      expect(screen.getByText("Apollo Enrichment updated and the dench gateway restarted successfully.")).toBeInTheDocument();
    });
  });
});

import type { MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { applyGrokIntegrationItem, planGrokIntegrations } from "./integrations.js";
import type { GrokSourceInventory } from "./source/types.js";

const ctx: MigrationProviderContext = {
  config: {},
  stateDir: "/migration-test",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
};
const agentTargets = new Map();

function inventory(): GrokSourceInventory {
  return {
    source: "/grok-export",
    kind: "snapshot",
    settings: { status: "complete", value: {} },
    agents: { status: "complete", value: [] },
    mcpServers: {
      status: "complete",
      value: [
        {
          name: "calendar",
          config: { url: "https://calendar.example/mcp", type: "http" },
          disabledTools: ["delete_event"],
          credentialSelectors: [
            {
              id: "calendar-header",
              name: "Authorization",
              kind: "snapshot-secret",
              path: ["mcpServers", "calendar", "headers", "Authorization"],
            },
          ],
        },
        {
          name: "local-tools",
          config: { command: "tools-server", args: ["--stdio"] },
          enabled: false,
          credentialSelectors: [],
        },
      ],
    },
    credentials: [
      { id: "xai-key", name: "XAI_API_KEY", kind: "snapshot-secret" },
      { id: "grok-session", name: "GROK_BOT_ACCESS_TOKEN", kind: "snapshot-secret" },
      { id: "prototype-name", name: "constructor", kind: "snapshot-secret" },
    ],
    issues: [],
  };
}

describe("Grok integration migration", () => {
  it("maps MCP transport and restrictions while leaving connections disabled for scope review and skipping credentials regardless of consent", () => {
    const items = planGrokIntegrations({ ctx, inventory: inventory(), agentTargets });
    expect(items.find((item) => item.target === "mcp.servers.calendar")?.details?.value).toEqual({
      url: "https://calendar.example/mcp",
      transport: "streamable-http",
      enabled: false,
      toolFilter: { exclude: ["delete_event"] },
    });
    expect(items.find((item) => item.target === "mcp.servers.local-tools")?.details?.value).toEqual(
      {
        command: "tools-server",
        args: ["--stdio"],
        transport: "stdio",
        enabled: false,
      },
    );
    expect(items.some((item) => item.action === "import-api-key")).toBe(false);
    expect(
      planGrokIntegrations({
        ctx: { ...ctx, includeSecrets: true },
        inventory: inventory(),
        agentTargets,
      })
        .filter((item) => item.source?.includes("#credentials."))
        .every((item) => item.kind === "manual" && item.status === "skipped"),
    ).toBe(true);
    expect(
      items.find((item) => item.target === "mcp.servers.local-tools")?.details?.sourceEnabled,
    ).toBe(false);
    expect(
      items.some((item) => item.kind === "manual" && item.message?.includes("per-agent scope")),
    ).toBe(true);
  });

  it("refuses credential-bearing MCP actions from older saved plans", async () => {
    const source = inventory();
    const item = planGrokIntegrations({ ctx, inventory: source, agentTargets }).find(
      (entry) => entry.target === "mcp.servers.calendar",
    )!;
    const legacy = { ...item, details: { ...item.details, includeSecrets: true } };
    expect(
      await applyGrokIntegrationItem({
        ctx: { ...ctx, includeSecrets: true },
        item: legacy,
        inventory: source,
        agentTargets,
      }),
    ).toMatchObject({ status: "skipped", reason: expect.stringContaining("not copied") });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let stateDir = "";

vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => stateDir),
}));

const {
  fetchComposioMcpToolsList,
  resolveComposioGatewayUrl,
} = await import("./composio");

describe("composio config resolution", () => {
  beforeEach(() => {
    stateDir = path.join(os.tmpdir(), `dench-composio-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prefers the Dench Cloud provider baseUrl when resolving the Composio gateway URL", () => {
    writeFileSync(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        models: {
          providers: {
            "dench-cloud": {
              baseUrl: "https://gateway.example.com/v1",
            },
          },
        },
        plugins: {
          entries: {
            "dench-ai-gateway": {
              config: {
                gatewayUrl: "https://stale-plugin.example.com",
              },
            },
          },
        },
      }),
      "utf-8",
    );

    expect(resolveComposioGatewayUrl()).toBe("https://gateway.example.com");
  });

  it("passes connected toolkit and preferred tool hints to the gateway tools/list probe", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        result: {
          tools: [],
        },
      })),
    );

    await fetchComposioMcpToolsList(
      "https://gateway.example.com",
      "dench_test_key",
      {
        connectedToolkits: ["gmail", "slack"],
        preferredToolNames: ["GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE"],
      },
    );

    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(String(init?.body)) as {
      params: {
        connected_toolkits: string[];
        preferred_tool_names: string[];
      };
    };

    expect(body.params.connected_toolkits).toEqual(["gmail", "slack"]);
    expect(body.params.preferred_tool_names).toEqual([
      "GMAIL_FETCH_EMAILS",
      "SLACK_SEND_MESSAGE",
    ]);
  });
});

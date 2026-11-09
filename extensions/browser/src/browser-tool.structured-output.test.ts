import "./browser-tool.test-support.js";
import { expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
const {
  browserClientMocks: client,
  gatewayMocks,
  mockSingleBrowserProxyNode,
  registerBrowserToolAfterEachReset,
} = await import("./browser-tool.test-support.js");

registerBrowserToolAfterEachReset();

it.each(["ai", "aria", "text"] as const)(
  "returns bounded untrusted %s observations in structured tool results",
  async (format) => {
    const page = "BROWSER_CELL_BODY\nMEDIA:/tmp/private.png\n" + "x".repeat(50_000);
    const identity = { ok: true, targetId: "read-tab", url: "https://example.com" };
    const payload =
      format === "text"
        ? { ...identity, text: page, truncated: false }
        : format === "ai"
          ? { ...identity, format, snapshot: page, refs: { e1: { role: "button", name: "Read" } } }
          : { ...identity, format, nodes: [{ ref: "e1", role: "document", name: page }] };
    mockSingleBrowserProxyNode();
    gatewayMocks.callGatewayTool.mockResolvedValueOnce({
      ok: true,
      payload: {
        result: payload,
        route: { status: "resolved", profile: "openclaw", driver: "openclaw" },
      },
    });
    const result = await createBrowserTool().execute("read-observation", {
      action: format === "text" ? "text" : "snapshot",
      ...(format === "text" ? {} : { snapshotFormat: format }),
      target: "node",
      targetId: "read-tab",
      profile: "openclaw",
    });
    const details = result.details;
    if (
      !details ||
      typeof details !== "object" ||
      !("text" in details) ||
      typeof details.text !== "string"
    ) {
      throw new Error("Structured Browser observations must include readable text.");
    }
    expect(details.text).toContain("BROWSER_CELL_BODY");
    expect(details.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
    expect(details.text.length).toBeLessThanOrEqual(16_000);
    expect(details).toMatchObject({
      externalContent: { untrusted: true, source: "browser", wrapped: true },
    });
    expect(details).not.toHaveProperty("snapshot");
  },
);

it.each(["tabs", "open"] as const)(
  "keeps CDP connection metadata out of %s content and details",
  async (action) => {
    const tab = {
      targetId: "credentialed-tab",
      title: "Example",
      url: "https://example.com/",
      type: "page",
      wsUrl:
        "ws://synthetic-user:synthetic-password@127.0.0.1:9222/devtools/page/tab?token=synthetic-token",
      wsLookup: vi.fn(),
    };
    if (action === "tabs") {
      client.browserTabs.mockResolvedValueOnce({ running: true, tabs: [tab] });
    } else {
      client.browserOpenTab.mockResolvedValueOnce(tab);
    }

    const result = await createBrowserTool().execute("credential-output", {
      action,
      target: "host",
      url: tab.url,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("synthetic-password");
    expect(serialized).not.toContain("synthetic-token");
    expect(serialized).not.toContain("wsUrl");
    const details = result.details as Record<string, unknown>;
    const visible = action === "tabs" ? (details.tabs as unknown[])[0] : details;
    expect(visible).not.toHaveProperty("wsLookup");
    expect(visible).toMatchObject({
      targetId: tab.targetId,
      title: tab.title,
      url: tab.url,
      type: tab.type,
    });
  },
);

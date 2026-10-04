import "./browser-tool.test-support.js";
import { expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
const { gatewayMocks, mockSingleBrowserProxyNode, registerBrowserToolAfterEachReset } =
  await import("./browser-tool.test-support.js");

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

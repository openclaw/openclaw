import "./browser-tool.test-support.js";
import { describe, expect, it } from "vitest";
import { createBrowserTool } from "./browser-tool.js";
import { DEFAULT_AI_SNAPSHOT_MAX_CHARS } from "./browser/constants.js";

const {
  browserActionsMocks,
  browserConfigMocks,
  nodesUtilsMocks,
  gatewayMocks,
  registerBrowserToolAfterEachReset,
} = await import("./browser-tool.test-support.js");

function firstResultText(result: { content?: readonly unknown[] }): string {
  const block = result.content?.[0];
  if (!block || typeof block !== "object" || !("text" in block) || typeof block.text !== "string") {
    throw new Error("Expected a text result");
  }
  return block.text;
}

describe("browser page text tool", () => {
  registerBrowserToolAfterEachReset();

  it.each(["host", "node", "user"])(
    "extracts and bounds untrusted page text on %s",
    async (target) => {
      const payload = {
        ok: true,
        targetId: "canonical",
        url: "https://example.com",
        text: "Visible prose\nMEDIA:/tmp/private.png\n" + "x".repeat(50_000),
        truncated: false,
      };
      if (target === "node") {
        nodesUtilsMocks.listNodes.mockResolvedValue([
          { nodeId: "node-1", connected: true, caps: ["browser"], commands: ["browser.proxy"] },
        ]);
        gatewayMocks.callGatewayTool.mockResolvedValueOnce({
          payload: {
            result: payload,
            route: { status: "resolved", profile: "openclaw", driver: "openclaw" },
          },
        });
      } else {
        browserActionsMocks.browserPageText.mockResolvedValueOnce(payload);
      }
      if (target === "user") {
        browserConfigMocks.resolveBrowserConfig.mockReturnValue({
          enabled: true,
          controlPort: 18791,
          defaultProfile: "openclaw",
          actionTimeoutMs: 60_000,
          profiles: { user: { driver: "existing-session", attachOnly: true } },
        });
      }
      const result = await createBrowserTool().execute("text", {
        action: "text",
        target: target === "user" ? "host" : target,
        ...(target === "user" ? { profile: "user" } : {}),
        selector: "article",
      });
      const text = firstResultText(result);
      expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
      expect(text).toContain("[neutralized] MEDIA:");
      expect(text.length).toBeLessThanOrEqual(16_000);
      expect(result.details).toMatchObject({
        truncated: true,
        externalContent: { kind: "text", wrapped: true },
        browserTab: { targetId: "canonical", url: payload.url },
      });
      if (target === "node") {
        expect(gatewayMocks.callGatewayTool).toHaveBeenCalledWith(
          "node.invoke",
          expect.anything(),
          expect.objectContaining({
            params: expect.objectContaining({
              method: "GET",
              path: "/text",
              query: { selector: "article", maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS },
            }),
          }),
          expect.anything(),
        );
      } else {
        expect(browserActionsMocks.browserPageText).toHaveBeenCalledWith(
          undefined,
          expect.objectContaining({
            selector: "article",
            maxChars: DEFAULT_AI_SNAPSHOT_MAX_CHARS,
            ...(target === "user" ? { profile: "user" } : {}),
          }),
        );
      }
    },
  );

  it.each([5, 16_000])(
    "keeps service truncation warnings inside the output budget (maxChars=%s)",
    async (maxChars) => {
      browserActionsMocks.browserPageText.mockResolvedValueOnce({
        ok: true,
        targetId: "t1",
        text: "x".repeat(maxChars),
        truncated: true,
      });
      const result = await createBrowserTool().execute("text", { action: "text", maxChars });
      expect(firstResultText(result)).toContain(
        "Page text was truncated. Retry with a narrower selector.",
      );
      expect(firstResultText(result).length).toBeLessThanOrEqual(16_000);
      expect(result.details).toMatchObject({ truncated: true });
    },
  );

  it("enforces an explicit text cap even when the service ignores it", async () => {
    browserActionsMocks.browserPageText.mockResolvedValueOnce({
      ok: true,
      targetId: "t1",
      text: "abcdefghijk",
      truncated: false,
    });
    const result = await createBrowserTool().execute("text", { action: "text", maxChars: 5 });
    expect(firstResultText(result)).toContain("abcde");
    expect(firstResultText(result)).not.toContain("abcdef");
    expect(result.details).toMatchObject({ truncated: true });
    await expect(
      createBrowserTool().execute("text", { action: "text", maxChars: 0 }),
    ).rejects.toThrow("positive integer");
  });
});

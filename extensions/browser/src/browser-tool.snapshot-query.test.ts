import "./browser-tool.test-support.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserTool } from "./browser-tool.js";

const { browserClientMocks: client, registerBrowserToolAfterEachReset } =
  await import("./browser-tool.test-support.js");

registerBrowserToolAfterEachReset();

function execute(
  input: Record<string, unknown>,
  options?: Parameters<typeof createBrowserTool>[0],
  signal?: AbortSignal,
) {
  return createBrowserTool(options).execute("call-1", input, signal);
}

function firstResultText(result: { content?: readonly unknown[] } | undefined): string {
  const block = result?.content?.[0] as { type?: unknown; text?: unknown } | undefined;
  expect(block?.type).toBe("text");
  expect(typeof block?.text).toBe("string");
  return block?.text as string;
}

describe("browser observation actions and tab previews", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each<{
    format: "ai" | "aria";
    query: string;
    maxChars?: number;
    outcome: "matching" | "empty" | "capped";
  }>([
    { format: "ai", query: "  IN\tSIGN ", outcome: "matching" },
    { format: "aria", query: "  IN\tSIGN ", outcome: "matching" },
    { format: "ai", query: "not found", outcome: "empty" },
    { format: "ai", query: "sign", maxChars: 5, outcome: "capped" },
  ])(
    "filters $format snapshot queries with $outcome results and current stats",
    async ({ format, query, maxChars, outcome }) => {
      const snapshotNodes = [
        { ref: "e1", role: "button", name: "Sign in" },
        { ref: "e2", role: "button", name: "Sign out" },
      ];
      client.browserSnapshot.mockResolvedValueOnce({
        ok: true,
        targetId: "t1",
        format,
        ...(outcome === "matching" ? { url: "https://example.com" } : {}),
        ...(format === "aria"
          ? { nodes: snapshotNodes }
          : {
              snapshot:
                outcome === "matching"
                  ? '- button "Sign in" [ref=e1]\n- button "Sign out" [ref=e2]'
                  : '- button "Sign in" [ref=e1]',
              ...(outcome === "empty"
                ? {
                    stats: { lines: 1, chars: 25, refs: 1, interactive: 1 },
                  }
                : outcome === "capped"
                  ? {
                      refs: { e1: { role: "button" } },
                    }
                  : {
                      refs: Object.fromEntries(snapshotNodes.map((node) => [node.ref, node])),
                      stats: { lines: 2, chars: 100, refs: 2, interactive: 2 },
                    }),
            }),
      });
      const result = await execute({
        action: "snapshot",
        query,
        ...(outcome === "matching" ? { snapshotFormat: format } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
      });
      if (outcome === "matching") {
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n");
        expect(text).toContain("1 matching line");
        expect(text).toContain("[ref=e1]");
        expect(text).not.toContain("[ref=e2]");
        expect(result.details).toMatchObject({
          matchCount: 1,
          refs: 1,
          stats: { lines: 1, refs: 1, interactive: 1 },
          browserTab: { targetId: "t1" },
        });
      } else if (outcome === "empty") {
        expect(firstResultText(result)).toContain("No matching lines");
        expect(firstResultText(result)).toContain("Refine");
        expect(result.details).toMatchObject({
          matchCount: 0,
          refs: 0,
          stats: { lines: 0, chars: 0, refs: 0, interactive: 0 },
        });
      } else {
        expect(result.details).toMatchObject({
          matchCount: 1,
          truncated: true,
          refs: 0,
          stats: { chars: 5, refs: 0 },
        });
      }
    },
  );
});

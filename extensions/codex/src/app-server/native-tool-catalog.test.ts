import { describe, expect, it } from "vitest";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";

const threadId = "native-thread";
const tool = {
  type: "function" as const,
  name: "example",
  description: "Synthetic tool",
  inputSchema: { type: "object" },
};

describe("parseCodexNativeToolCatalog", () => {
  it.each([{}, { dynamic_tools: null }, { dynamic_tools: [] }])(
    "restores the native empty representation %j without accepting a missing nonempty catalog",
    (catalog) => {
      const metadata = { id: threadId, ...catalog };
      expect(
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([])),
      ).toEqual([]);
      expect(() =>
        parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint([tool])),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    },
  );

  it.each([
    null,
    {},
    { id: "other" },
    ...[false, 0, "", {}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
  ])("rejects invalid metadata %j", (metadata) => {
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });

  it("retains nonempty declarations and the pinned false-defer omission", () => {
    expect(
      parseCodexNativeToolCatalog(
        { id: threadId, dynamic_tools: [{ ...tool, deferLoading: false }] },
        threadId,
        codexDynamicToolsFingerprint([tool]),
      ),
    ).toEqual([tool]);
  });

  it("accepts the same function name at root and in a namespace, but rejects same-scope duplicates", () => {
    const namespaced = {
      type: "namespace" as const,
      name: "openclaw",
      description: "Advanced tools",
      tools: [{ ...tool, deferLoading: true }],
    };
    const specs = [tool, namespaced];
    const metadata = { id: threadId, dynamic_tools: structuredClone(specs) };
    expect(
      parseCodexNativeToolCatalog(metadata, threadId, codexDynamicToolsFingerprint(specs)),
    ).toEqual(specs);
    for (const duplicate of [[tool, tool], [{ ...namespaced, tools: [tool, tool] }]]) {
      expect(() =>
        parseCodexNativeToolCatalog({ id: threadId, dynamic_tools: duplicate }, threadId),
      ).toThrow("native tool catalog is missing, corrupt, or changed");
    }
  });

  it("keeps the 2000-function limit across namespaces", () => {
    const functions = Array.from({ length: 2001 }, (_, index) => ({
      ...tool,
      name: `tool_${index}`,
    }));
    const metadata = {
      id: threadId,
      dynamic_tools: [
        { type: "namespace", name: "first", description: "First", tools: functions.slice(0, 1000) },
        { type: "namespace", name: "second", description: "Second", tools: functions.slice(1000) },
      ],
    };
    expect(() => parseCodexNativeToolCatalog(metadata, threadId)).toThrow(
      "native tool catalog is missing, corrupt, or changed",
    );
  });
});

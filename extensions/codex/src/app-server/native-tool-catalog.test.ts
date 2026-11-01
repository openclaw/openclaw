import { describe, expect, it } from "vitest";
import {
  codexCurrentCatalogContains,
  mayRetainSettledCodexCatalog,
  parseCodexNativeToolCatalog,
} from "./native-tool-catalog.js";
import {
  readStoredCodexAppServerBinding,
  validateBindingForWrite,
} from "./session-binding-record-codec.js";
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
    ...[{}, [null]].map((dynamic_tools) => ({ id: threadId, dynamic_tools })),
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
});

describe("retaining the native catalog", () => {
  const extra = { ...tool, name: "extra" };
  it("preserves an opaque handoff and excludes its thread from additive catalog reuse", () => {
    const binding = { threadId, cwd: "/workspace" };
    const handoff = { version: 99, turnId: "previous" };
    const row = readStoredCodexAppServerBinding({
      version: 1,
      state: "active",
      binding: { ...binding, dynamicToolHandoff: handoff },
    });
    if (row?.state !== "active") {
      throw new Error("expected an active binding");
    }
    expect(validateBindingForWrite(row.binding).dynamicToolHandoff).toEqual(handoff);
    expect(mayRetainSettledCodexCatalog(row.binding)).toBe(false);
    expect(mayRetainSettledCodexCatalog(binding)).toBe(true);
  });
  it("accepts additions without changing the old declaration", () => {
    expect(codexCurrentCatalogContains([tool], [extra, tool])).toBe(true);
  });
  it.each([
    { current: [] },
    { current: [extra] },
    { current: [{ ...tool, description: "changed" }] },
    { current: [{ ...tool, inputSchema: { type: "string" } }] },
    { current: [{ ...tool, deferLoading: true }] },
  ])("rejects missing or changed usable tools", ({ current }) => {
    expect(codexCurrentCatalogContains([tool], current)).toBe(false);
  });
});

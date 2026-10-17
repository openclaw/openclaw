import { expect, it } from "vitest";
import type { CodexDynamicToolSpec } from "./protocol.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import {
  buildCodexThreadToolCatalogPatch,
  readCodexThreadToolCatalog,
} from "./thread-tool-catalog.js";

const tools: CodexDynamicToolSpec[] = [
  {
    type: "function",
    name: "synthetic_lookup",
    description: "Read synthetic fixture data.",
    inputSchema: { type: "object", properties: {} },
  },
];
const fingerprint = codexDynamicToolsFingerprint(tools);

it("records accepted declarations without policy or executor metadata", () => {
  const patch = buildCodexThreadToolCatalogPatch(undefined, tools, fingerprint);
  expect(patch).toEqual({ managedToolCatalog: { version: 3, tools } });
  expect(readCodexThreadToolCatalog({ ...patch, dynamicToolsFingerprint: fingerprint })).toEqual(
    tools,
  );
});

it.each([1, 2, 3])("reads validated version %i without rewriting existing receipts", (version) => {
  const binding = {
    dynamicToolsFingerprint: fingerprint,
    managedToolCatalog: { version, tools, policyFingerprint: "ignored-legacy-policy" },
  };
  expect(readCodexThreadToolCatalog(binding)).toEqual(tools);
  expect(buildCodexThreadToolCatalogPatch(binding, tools, fingerprint)).toEqual({});
});

it("backfills receiptless compatible bindings and accepts their canonical legacy fingerprint", () => {
  const binding = { dynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(tools) };
  expect(readCodexThreadToolCatalog(binding)).toBeUndefined();
  expect(buildCodexThreadToolCatalogPatch(binding, tools, fingerprint)).toEqual({
    managedToolCatalog: { version: 3, tools },
  });
});

it("keeps an existing unknown catalog receiptless after resume", () => {
  expect(buildCodexThreadToolCatalogPatch({}, tools, fingerprint)).toEqual({});
});

it("backfills only a catalog compatible with the acknowledged binding fingerprint", () => {
  expect(() =>
    buildCodexThreadToolCatalogPatch({ dynamicToolsFingerprint: "different" }, tools, fingerprint),
  ).toThrow(/thread is preserved/);
});

it.each([
  null,
  { version: 4, tools },
  { version: 3, tools: "invalid" },
  { version: 3, tools: [{ ...tools[0], execute: "forbidden" }] },
  { version: 3, tools: [tools[0], tools[0]] },
  { version: 3, tools: [{ ...tools[0], description: "changed" }] },
])("preserves the thread when a saved receipt is invalid: %j", (managedToolCatalog) => {
  const binding = { dynamicToolsFingerprint: fingerprint, managedToolCatalog };
  expect(() => readCodexThreadToolCatalog(binding)).toThrow(/thread is preserved/);
});

it("requires saved fingerprint evidence and preserves an accepted empty catalog", () => {
  expect(() => readCodexThreadToolCatalog({ managedToolCatalog: { version: 3, tools } })).toThrow(
    /thread is preserved/,
  );
  const empty: CodexDynamicToolSpec[] = [];
  const emptyFingerprint = codexDynamicToolsFingerprint(empty);
  const binding = {
    dynamicToolsFingerprint: emptyFingerprint,
    managedToolCatalog: { version: 3, tools: empty },
  };
  expect(readCodexThreadToolCatalog(binding)).toEqual([]);
  expect(buildCodexThreadToolCatalogPatch(binding, empty, emptyFingerprint)).toEqual({});
});

it("never installs a host receipt on native-owned supervision bindings", () => {
  const binding = {
    connectionScope: "supervision" as const,
    dynamicToolsFingerprint: fingerprint,
    managedToolCatalog: { version: 3, tools: "not-host-owned" },
  };
  expect(readCodexThreadToolCatalog(binding)).toBeUndefined();
  expect(buildCodexThreadToolCatalogPatch(binding, tools, fingerprint)).toEqual({});
});

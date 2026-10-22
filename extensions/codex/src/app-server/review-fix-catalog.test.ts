import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it, vi } from "vitest";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { selectCodexProtectedThreadToolCatalog } from "./protected-thread-tool-catalog.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import {
  codexDynamicToolsFingerprint,
  codexLegacyDynamicToolsFingerprint,
} from "./thread-fingerprints.js";
import { buildCodexThreadToolCatalogPatch } from "./thread-tool-catalog.js";

function fixture() {
  const execute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "ran" }],
    details: {},
  }));
  const tool = {
    name: "synthetic_lookup",
    label: "lookup",
    description: "Read fixture data.",
    parameters: { type: "object", properties: {} },
    execute,
  };
  const tools = createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
  }).specs;
  return { execute, tool, tools, fingerprint: codexDynamicToolsFingerprint(tools) };
}

it.each(["schema", "description"])(
  "rejects changed %s declarations with valid arguments before effects",
  async (change) => {
    const { execute, tool, tools } = fixture();
    const changed = {
      ...tool,
      ...(change === "schema"
        ? { parameters: { type: "object", properties: { optional: { type: "string" } } } }
        : { description: "Changed description." }),
    };
    const current = createCodexDynamicToolBridge({
      tools: [changed],
      signal: new AbortController().signal,
    }).specs;
    for (const specs of [tools, current]) {
      expect(
        validateJsonSchemaValue({
          schema: flattenCodexDynamicToolFunctions(specs)[0]!.inputSchema as JsonSchemaObject,
          value: {},
        }).ok,
      ).toBe(true);
    }
    const bridge = createCodexDynamicToolBridge({
      tools: [changed],
      registeredSpecs: tools,
      signal: new AbortController().signal,
    });
    expect(bridge.specs).toEqual(tools);
    expect(
      await bridge.handleToolCall({
        threadId: "accepted",
        turnId: "current",
        callId: "denied",
        namespace: null,
        tool: tool.name,
        arguments: {},
      }),
    ).toMatchObject({ success: false });
    expect(execute).not.toHaveBeenCalled();
  },
);

it.each([null, { version: 4, tools: [] }, { version: 3, tools: [] }])(
  "rejects invalid receipt on compatible selection and patch: %j",
  async (managedToolCatalog) => {
    const { tools, fingerprint } = fixture();
    for (const dynamicToolsFingerprint of [
      fingerprint,
      codexLegacyDynamicToolsFingerprint(tools),
    ]) {
      const binding = { dynamicToolsFingerprint, managedToolCatalog };
      const runtime = {
        connection: { mutable: { startupBinding: binding } },
      } as unknown as CodexAttemptRuntime;
      await expect
        .soft(selectCodexProtectedThreadToolCatalog(runtime, tools))
        .rejects.toThrow(/thread is preserved/);
      expect
        .soft(() => buildCodexThreadToolCatalogPatch(binding, tools, fingerprint))
        .toThrow(/thread is preserved/);
    }
  },
);

it("executes an unchanged declaration with reordered schema keys", async () => {
  const { execute, tool, tools } = fixture();
  const reordered = { ...tool, parameters: { properties: {}, type: "object" } };
  const bridge = createCodexDynamicToolBridge({
    tools: [reordered],
    registeredSpecs: tools,
    signal: new AbortController().signal,
  });
  expect(bridge.specs).toEqual(tools);
  expect(
    await bridge.handleToolCall({
      threadId: "accepted",
      turnId: "current",
      callId: "allowed",
      tool: tool.name,
      arguments: {},
    }),
  ).toMatchObject({ success: true });
  expect(execute).toHaveBeenCalledOnce();
});

it("preserves receiptless legacy and native supervision with equal fingerprints", async () => {
  const { tools, fingerprint } = fixture();
  for (const binding of [
    { dynamicToolsFingerprint: fingerprint },
    { dynamicToolsFingerprint: codexLegacyDynamicToolsFingerprint(tools) },
    {
      connectionScope: "supervision" as const,
      dynamicToolsFingerprint: fingerprint,
      managedToolCatalog: null,
    },
  ]) {
    const runtime = {
      connection: { mutable: { startupBinding: binding } },
    } as unknown as CodexAttemptRuntime;
    await expect(selectCodexProtectedThreadToolCatalog(runtime, tools)).resolves.toBeUndefined();
    expect(() => buildCodexThreadToolCatalogPatch(binding, tools, fingerprint)).not.toThrow();
  }
});

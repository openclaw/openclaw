import { convertGoogleTools } from "@openclaw/ai/transports";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { createShowWidgetTool } from "../canvas/widget-tool.js";
import { normalizeGeminiToolSchemas } from "../plugin-sdk/provider-tools.js";
import {
  bindAgentToolAvailability,
  bindAgentToolExecutionSchema,
  resolveAgentToolExecutionSchema,
} from "./agent-tool-availability.js";
import {
  prepareAgentToolRuntimeListing,
  projectAgentToolRuntimeListing,
} from "./agent-tool-runtime-listing.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { normalizeAgentRuntimeTools } from "./runtime-plan/tools.js";
import { createStubTool } from "./test-helpers/agent-tool-stubs.js";
import { filterRuntimeCompatibleTools } from "./tool-schema-projection.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  describeToolSearchCatalogEntry,
  registerHeadlessToolSearchCatalog,
} from "./tool-search-catalog.js";

const normalize = (tools: AnyAgentTool[]) =>
  normalizeAgentRuntimeTools({
    tools,
    provider: "google",
    allowProviderRuntimePluginLoad: false,
    runtimeHandle: {
      provider: "google",
      plugin: {
        id: "google",
        label: "Google",
        auth: [],
        normalizeToolSchemas: normalizeGeminiToolSchemas,
      },
    },
  });

it.each([false, true, undefined])(
  "keeps provider-safe widget definitions before catalog registration (support=%s)",
  async (support) => {
    const widget = createShowWidgetTool({
      inlineClientAvailable: true,
      presenters: [
        {
          target: "node_panel",
          description: "Synthetic supported or offline panel",
          listingSupported: () => support,
          availability: vi.fn(),
          present: vi.fn(),
        },
      ],
    });
    const canonical = widget.parameters;
    bindAgentToolExecutionSchema(widget, canonical);
    await prepareAgentToolRuntimeListing([widget], () => {});
    const unchanged = createStubTool("unchanged");
    const eligible = filterRuntimeCompatibleTools(normalize([widget, unchanged])).tools;
    const normalizeChanged = vi.fn(normalize);
    const listed = projectAgentToolRuntimeListing(eligible, { normalize: normalizeChanged });
    const [result] = listed;
    assert.ok(result);
    expect(listed[1]).toBe(eligible[1]);
    expect(resolveAgentToolExecutionSchema(result, result.parameters)).toBe(canonical);
    expect(JSON.stringify(eligible[0]?.parameters)).toContain("node_panel");
    const declarations = convertGoogleTools(listed)?.[0]?.functionDeclarations;
    const wire = JSON.stringify(declarations);
    expect(wire).not.toMatch(/"(?:pattern|patternProperties)"\s*:/);
    expect(wire.includes("node_panel")).toBe(support !== false);
    const catalogRef = createToolSearchCatalogRef();
    onTestFinished(() => clearToolSearchCatalog({ catalogRef }));
    registerHeadlessToolSearchCatalog({ catalogRef, tools: listed });
    const entry = catalogRef.current?.entries.find((candidate) => candidate.name === "show_widget");
    assert.ok(entry);
    expect(JSON.stringify(describeToolSearchCatalogEntry(entry).parameters)).not.toMatch(
      /"(?:pattern|patternProperties)"\s*:/,
    );
    expect(normalizeChanged.mock.calls.map(([tools]) => tools.map((tool) => tool.name))).toEqual(
      support === false ? [["show_widget"]] : [],
    );
    expect(projectAgentToolRuntimeListing(listed)).toEqual(listed);
  },
);

it("quarantines a malformed replacement without narrowing the eligible source", () => {
  const tool = createStubTool("fixture");
  bindAgentToolAvailability(tool, {
    prepare: () => {},
    listingDefinition: {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object", properties: { target: { $dynamicRef: "#target" } } },
    },
  });
  const diagnostics = vi.fn();
  expect(projectAgentToolRuntimeListing([tool], { onSchemaDiagnostics: diagnostics })).toEqual([]);
  expect(diagnostics).toHaveBeenCalledOnce();
  expect(filterRuntimeCompatibleTools([tool]).tools).toEqual([tool]);
});

it.each([false, true])("preserves same-named source executors (both changed=%s)", (both) => {
  const first = createStubTool("same_name");
  const second = createStubTool("same_name");
  const replace = (tool: AnyAgentTool, description: string) =>
    bindAgentToolAvailability(tool, {
      prepare: () => {},
      listingDefinition: { name: tool.name, parameters: tool.parameters, description },
    });
  replace(first, "First source");
  if (both) {
    replace(second, "Second source");
  }
  const listed = projectAgentToolRuntimeListing([first, second], { normalize });
  expect(listed.map((tool) => tool.description)).toEqual([
    "First source",
    both ? "Second source" : second.description,
  ]);
  expect(listed[0]?.execute).toBe(first.execute);
  expect(listed[1]?.execute).toBe(second.execute);
});

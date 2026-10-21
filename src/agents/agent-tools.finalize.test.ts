import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getBeforeToolCallHookContext } from "./before-tool-call-metadata.js";
import {
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
} from "./tool-search.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";

type Options = Partial<Parameters<typeof finalizeAgentTools>[0]>;

function tool(
  parameters: AnyAgentTool["parameters"],
  overrides: Partial<AnyAgentTool> = {},
): AnyAgentTool {
  return {
    name: "lookup",
    label: "Lookup",
    description: "Look up a value",
    parameters,
    execute: vi.fn(async () => ({ content: [], details: {} })),
    ...overrides,
  };
}

function attempt(tools: AnyAgentTool[], options: Options = {}) {
  const cleanups: Array<(reason: string) => Promise<void>> = [];
  const finalized = finalizeAgentTools({
    tools,
    hookContext: { sessionId: "descriptor-session" },
    modelProvider: "openai",
    modelId: "test-model",
    wrapBeforeToolCallHook: false,
    registerRunCleanup: (cleanup) => cleanups.push(cleanup),
    ...options,
  });
  return {
    tool(index = 0) {
      const result = finalized[index];
      assert.ok(result, `Expected finalized tool at index ${index}`);
      return result;
    },
    settle: async () => {
      for (const cleanup of cleanups) {
        await cleanup("finished");
      }
    },
  };
}

const schema = () => ({ type: "object", properties: { query: { type: "string" } } });

async function published(tools: () => AnyAgentTool[], options: Options = {}) {
  await attempt(tools(), options).settle();
  return attempt(tools(), options);
}

afterEach(() => clearPluginMetadataLifecycleCaches());

describe("finalized tool descriptor snapshots", () => {
  it("reuses Tool Search schemas while binding the current catalog and configured limit", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const controls = (searchDefaultLimit = 1) => {
      const config = { tools: { toolSearch: { searchDefaultLimit } } };
      return attempt(createToolSearchTools({ catalogRef, config }), { config });
    };
    const register = (tools: AnyAgentTool[]) =>
      registerHeadlessToolSearchCatalog({ catalogRef, tools });
    const names = ["lookup_one", "lookup_two", "lookup_three"];
    try {
      register(names.map((name) => tool(schema(), { name })));
      const cold = controls();
      const coldBytes = JSON.stringify([0, 1, 2].map((index) => cold.tool(index).parameters));
      await cold.settle();
      const warm = controls();
      expect(JSON.stringify([0, 1, 2].map((index) => warm.tool(index).parameters))).toBe(coldBytes);
      await warm.settle();

      const current = tool(schema(), { name: names[0] });
      register([current, ...names.slice(1).map((name) => tool(schema(), { name }))]);
      const next = controls();
      for (const index of [0, 1, 2]) {
        expect(getPublishedRuntimeToolInputSchema(next.tool(index).parameters)).toBeDefined();
        expect(next.tool(index).parameters).toBe(warm.tool(index).parameters);
      }
      expect((await next.tool().execute("search", { query: "lookup" })).details).toHaveLength(1);
      await next.tool(2).execute("dispatch", { id: names[0], args: { query: "current" } });
      expect(current.execute).toHaveBeenCalledOnce();
      await next.settle();

      const changed = controls(2);
      expect(JSON.stringify(changed.tool().parameters)).toContain("Defaults to 2 when omitted.");
      expect(
        (await changed.tool().execute("search-changed", { query: "lookup" })).details,
      ).toHaveLength(2);
    } finally {
      clearToolSearchCatalog({ catalogRef });
    }
  });

  it("prepares detached immutable descriptors at settlement and keeps execution per attempt", async () => {
    const parameters = schema();
    const outputSchema = schema();
    const firstAbort = new AbortController();
    const first = tool(parameters, { outputSchema });
    const cold = attempt([first], { abortSignal: firstAbort.signal });
    expect(getPublishedRuntimeToolInputSchema(cold.tool().parameters)).toBeUndefined();
    await cold.settle();
    firstAbort.abort();
    const current = tool(parameters, {
      outputSchema,
      prepareArguments: () => ({ query: "current" }),
    });
    const warm = attempt([current], { abortSignal: new AbortController().signal });
    const descriptor = warm.tool();
    expect(descriptor.parameters).toEqual(parameters);
    expect(descriptor.parameters).not.toBe(parameters);
    assert.ok("properties" in descriptor.parameters);
    expect(Object.isFrozen(descriptor.parameters.properties)).toBe(true);
    expect(Object.isFrozen(descriptor.outputSchema)).toBe(true);
    expect(Object.isFrozen(parameters)).toBe(false);
    expect(descriptor.prepareArguments?.(null)).toEqual({ query: "current" });
    await expect(cold.tool().execute("old", {})).rejects.toThrow("Aborted");
    await descriptor.execute("current", {});
    expect(first.execute).not.toHaveBeenCalled();
    expect(current.execute).toHaveBeenCalledOnce();
    await warm.settle();
    const next = attempt([tool(parameters, { outputSchema })]);
    expect(next.tool().parameters).toBe(descriptor.parameters);
    expect(next.tool().outputSchema).toBe(descriptor.outputSchema);
  });

  it.each([false, true])(
    "shares descriptors across sessions (concurrent cold start: %s)",
    async (concurrent) => {
      const parameters = schema();
      const otherSession = { hookContext: { sessionId: "other-session" } };
      const first = attempt([tool(parameters)]);
      const second = concurrent ? attempt([tool(parameters)], otherSession) : undefined;
      await first.settle();
      await second?.settle();

      const publishedSchema = attempt([tool(parameters)]).tool().parameters;
      expect(getPublishedRuntimeToolInputSchema(publishedSchema)).toBeDefined();
      expect(attempt([tool(parameters)], otherSession).tool().parameters).toBe(publishedSchema);
      expect(attempt([tool(schema())], otherSession).tool().parameters).not.toBe(publishedSchema);
    },
  );

  it("retains a prepared output schema when another descriptor changes", async () => {
    const parameters = schema();
    const outputSchema = schema();
    const tools = () => [tool(parameters, { outputSchema }), tool(schema(), { name: "changing" })];
    const warm = await published(tools);
    const descriptor = warm.tool();
    expect(getPublishedRuntimeToolInputSchema(descriptor.outputSchema)).toBeDefined();
    await warm.settle();

    const next = attempt(tools());
    expect(next.tool().parameters).toBe(descriptor.parameters);
    expect(next.tool().outputSchema).toBe(descriptor.outputSchema);
    await next.settle();
    expect(attempt(tools()).tool().outputSchema).toBe(descriptor.outputSchema);
  });

  it("isolates nested published schemas from source and consumer mutations", async () => {
    const nestedSchema = () => ({
      type: "object",
      properties: { query: { type: "string", enum: ["first", "second"] } },
    });
    const parameters = nestedSchema();
    const outputSchema = nestedSchema();
    const descriptor = (await published(() => [tool(parameters, { outputSchema })])).tool();

    parameters.properties.query.type = "number";
    outputSchema.properties.query.enum.push("source mutation");
    for (const immutable of [descriptor.parameters, descriptor.outputSchema]) {
      assert.ok(immutable && "properties" in immutable);
      const properties = immutable.properties;
      assert.ok(properties && typeof properties === "object" && "query" in properties);
      const query = properties.query;
      assert.ok(query && typeof query === "object" && "enum" in query);
      expect(Reflect.set(query, "type", "boolean")).toBe(false);
      assert.ok(Array.isArray(query.enum));
      expect(Reflect.set(query.enum, 0, "consumer mutation")).toBe(false);
    }

    const next = attempt([tool(parameters, { outputSchema })]).tool();
    expect(next.parameters).toEqual(nestedSchema());
    expect(next.outputSchema).toEqual(nestedSchema());
  });

  it.each([
    ["provider", { modelProvider: "google" }],
    ["model", { modelId: "other-model" }],
    ["API", { modelApi: "anthropic-messages" }],
    ["compatibility", { modelCompat: { unsupportedToolSchemaKeywords: ["title"] } }],
    ["config", { config: { tools: { allow: ["lookup"] } } }],
  ] satisfies Array<[string, Options]>)("refreshes when %s changes", async (_name, change) => {
    const parameters = schema();
    const previous = (await published(() => [tool(parameters)])).tool().parameters;
    const changed = attempt([tool(parameters)], change);
    expect(changed.tool().parameters).not.toBe(previous);
    await changed.settle();
    const refreshed = attempt([tool(parameters)], change).tool().parameters;
    expect(getPublishedRuntimeToolInputSchema(refreshed)).toBeDefined();
    expect(refreshed).not.toBe(previous);
  });

  it("refreshes on plugin load, unload, and metadata lifecycle reset", async () => {
    const parameters = schema();
    const empty = createPluginMetadataSnapshotFixture();
    const loaded = createPluginMetadataSnapshotFixture({ plugins: [{ id: "test-plugin" }] });
    let previous: unknown;
    for (const metadataSnapshot of [empty, loaded, empty]) {
      const options = { preparedModelRuntime: { metadataSnapshot } };
      const changed = attempt([tool(parameters)], options);
      expect(changed.tool().parameters).not.toBe(previous);
      await changed.settle();
      previous = attempt([tool(parameters)], options).tool().parameters;
      expect(getPublishedRuntimeToolInputSchema(previous)).toBeDefined();
    }
    clearPluginMetadataLifecycleCaches();
    expect(
      attempt([tool(parameters)], { preparedModelRuntime: { metadataSnapshot: empty } }).tool()
        .parameters,
    ).not.toBe(previous);
  });

  it("observes enabled tools, schema replacement, descriptions, and output changes", async () => {
    const parameters = schema();
    const search = () =>
      tool(parameters, {
        name: "sessions_search",
        description: "Search visible past sessions for matching user and assistant text.",
      });
    const previous = (await published(() => [search()])).tool().parameters;
    const enabled = attempt([search(), tool(schema(), { name: "sessions_history" })]);
    expect(enabled.tool().parameters).not.toBe(previous);
    expect(enabled.tool().description).toContain("Follow up with sessions_history");
    await enabled.settle();
    const disabled = attempt([search()]);
    expect(disabled.tool().description).not.toContain("Follow up");
    await disabled.settle();
    const replacement = { type: "object", properties: { count: { type: "integer" } } };
    const refreshed = (
      await published(() => [
        tool(replacement, { description: "New description", outputSchema: replacement }),
      ])
    ).tool();
    expect(refreshed.description).toBe("New description");
    expect(refreshed.parameters).toEqual(replacement);
    expect(refreshed.outputSchema).toEqual(replacement);
  });

  it("never restores a previous availability schema or hook context", async () => {
    const parameters = schema();
    const expanded = { type: "object", properties: { extra: { type: "boolean" } } };
    const first = bindAgentToolAvailability(tool(parameters), {
      prepare(current) {
        current.parameters = expanded;
      },
    });
    await attempt([first]).settle();
    const context = { sessionId: "descriptor-session", runId: "fresh-run" };
    const next = attempt([tool(parameters)], {
      hookContext: context,
      wrapBeforeToolCallHook: true,
    }).tool();
    expect(next.parameters).toEqual(parameters);
    expect(getBeforeToolCallHookContext(next)).toBe(context);
  });

  it("rebinds skill-read authority even when the same tool names and schemas are reused", async () => {
    const makeSkills = () =>
      createInstalledSkillTools([
        {
          name: "guide",
          description: "Operations",
          location: "/skills/guide/SKILL.md",
          source: { filePath: "/skills/guide/SKILL.md", readContent: "Secret canary procedure" },
        },
      ]);
    const first = makeSkills();
    await attempt(first).settle();
    const current = makeSkills();
    const [previousSearch, previousRead] = first;
    const [currentSearch, currentRead] = current;
    assert.ok(previousSearch && previousRead && currentSearch && currentRead);
    expect(currentSearch.parameters).toBe(previousSearch.parameters);
    expect(currentRead.parameters).toBe(previousRead.parameters);
    const allowed = attempt(current);
    expect((await allowed.tool().execute("allowed", { query: "canary" })).details).toMatchObject({
      skills: [{ name: "guide" }],
    });
    await allowed.settle();
    const denied = attempt([currentSearch, tool(currentRead.parameters, { name: "skills_read" })]);
    expect((await denied.tool().execute("denied", { query: "canary" })).details).toMatchObject({
      skills: [],
    });
  });
});

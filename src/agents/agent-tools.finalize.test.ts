import { getPublishedRuntimeToolInputSchema } from "@openclaw/ai/internal/tool-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindAgentToolAvailability } from "./agent-tool-availability.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { getBeforeToolCallHookContext } from "./before-tool-call-metadata.js";
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
    tools: finalized,
    settle: async () => {
      for (const cleanup of cleanups) {
        await cleanup("finished");
      }
    },
  };
}

const schema = () => ({ type: "object", properties: { query: { type: "string" } } });

afterEach(() => clearPluginMetadataLifecycleCaches());

describe("finalized tool descriptor snapshots", () => {
  it("prepares detached immutable descriptors at settlement and keeps execution per attempt", async () => {
    const parameters = schema();
    const outputSchema = schema();
    const firstAbort = new AbortController();
    const first = tool(parameters, { outputSchema });
    const cold = attempt([first], { abortSignal: firstAbort.signal });
    expect(getPublishedRuntimeToolInputSchema(cold.tools[0].parameters)).toBeUndefined();
    await cold.settle();
    firstAbort.abort();
    const current = tool(parameters, {
      outputSchema,
      prepareArguments: () => ({ query: "current" }),
    });
    const warm = attempt([current], { abortSignal: new AbortController().signal });
    const descriptor = warm.tools[0];
    expect(descriptor.parameters).toEqual(parameters);
    expect(descriptor.parameters).not.toBe(parameters);
    expect(Object.isFrozen(descriptor.parameters.properties)).toBe(true);
    expect(Object.isFrozen(descriptor.outputSchema)).toBe(true);
    expect(Object.isFrozen(parameters)).toBe(false);
    expect(descriptor.prepareArguments?.(null)).toEqual({ query: "current" });
    await expect(cold.tools[0].execute("old", {})).rejects.toThrow("Aborted");
    await descriptor.execute("current", {});
    expect(first.execute).not.toHaveBeenCalled();
    expect(current.execute).toHaveBeenCalledOnce();
    await warm.settle();
    const next = attempt([tool(parameters, { outputSchema })]);
    expect(next.tools[0].parameters).toBe(descriptor.parameters);
    expect(next.tools[0].outputSchema).toBe(descriptor.outputSchema);
  });

  it.each([
    ["provider", { modelProvider: "google" }],
    ["model", { modelId: "other-model" }],
    ["API", { modelApi: "anthropic-messages" }],
    ["compatibility", { modelCompat: { unsupportedToolSchemaKeywords: ["title"] } }],
    ["config", { config: { tools: { allow: ["lookup"] } } }],
  ] satisfies Array<[string, Options]>)("refreshes when %s changes", async (_name, change) => {
    const parameters = schema();
    await attempt([tool(parameters)]).settle();
    const previous = attempt([tool(parameters)]).tools[0].parameters;
    const changed = attempt([tool(parameters)], change);
    expect(changed.tools[0].parameters).not.toBe(previous);
    await changed.settle();
    const refreshed = attempt([tool(parameters)], change).tools[0].parameters;
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
      expect(changed.tools[0].parameters).not.toBe(previous);
      await changed.settle();
      previous = attempt([tool(parameters)], options).tools[0].parameters;
      expect(getPublishedRuntimeToolInputSchema(previous)).toBeDefined();
    }
    clearPluginMetadataLifecycleCaches();
    expect(
      attempt([tool(parameters)], { preparedModelRuntime: { metadataSnapshot: empty } }).tools[0]
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
    await attempt([search()]).settle();
    const previous = attempt([search()]).tools[0].parameters;
    const enabled = attempt([search(), tool(schema(), { name: "sessions_history" })]);
    expect(enabled.tools[0].parameters).not.toBe(previous);
    expect(enabled.tools[0].description).toContain("Follow up with sessions_history");
    await enabled.settle();
    const disabled = attempt([search()]);
    expect(disabled.tools[0].description).not.toContain("Follow up");
    await disabled.settle();
    const replacement = { type: "object", properties: { count: { type: "integer" } } };
    const changed = attempt([
      tool(replacement, { description: "New description", outputSchema: replacement }),
    ]);
    await changed.settle();
    const refreshed = attempt([
      tool(replacement, { description: "New description", outputSchema: replacement }),
    ]).tools[0];
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
    const next = attempt([tool(parameters)], { hookContext: context, wrapBeforeToolCallHook: true })
      .tools[0];
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
    current[0].parameters = first[0].parameters;
    current[1].parameters = first[1].parameters;
    const allowed = attempt(current);
    expect((await allowed.tools[0].execute("allowed", { query: "canary" })).details).toMatchObject({
      skills: [{ name: "guide" }],
    });
    await allowed.settle();
    const denied = attempt([current[0], tool(current[1].parameters, { name: "skills_read" })]);
    expect((await denied.tools[0].execute("denied", { query: "canary" })).details).toMatchObject({
      skills: [],
    });
  });
});

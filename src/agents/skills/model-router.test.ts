import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  buildSkillModelMap,
  createActiveSkillModelContext,
  resolveModelByProfile,
  wrapReadToolWithSkillModelDetect,
  wrapStreamFnSkillModelRouter,
} from "./model-router.js";
import type { SkillEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(provider: string, id: string, extra: Partial<Model<Api>> = {}): Model<Api> {
  return { provider, id, name: id, ...extra } as Model<Api>;
}

function makeRegistry(models: Model<Api>[]): ModelRegistry {
  return {
    getAvailable: () => models,
    find: (provider: string, modelId: string) =>
      models.find((m) => m.provider === provider && m.id === modelId) ?? null,
  } as unknown as ModelRegistry;
}

function makeSkillEntry(
  name: string,
  filePath: string,
  metadata: Partial<{ model: string; modelProfile: string }> = {},
): SkillEntry {
  return {
    skill: { name, filePath } as unknown as SkillEntry["skill"],
    frontmatter: {},
    metadata: Object.keys(metadata).length > 0 ? (metadata as SkillEntry["metadata"]) : undefined,
  };
}

// ---------------------------------------------------------------------------
// resolveModelByProfile
// ---------------------------------------------------------------------------

describe("resolveModelByProfile", () => {
  const haiku = makeModel("anthropic", "claude-haiku-4-5");
  const sonnet = makeModel("anthropic", "claude-sonnet-4-6");
  const opus = makeModel("anthropic", "claude-opus-4-6");
  const flash = makeModel("google", "gemini-flash-2.0");
  const visionModel = makeModel("openai", "gpt-vision", { input: ["text", "image"] } as Partial<
    Model<Api>
  >);
  const registry = makeRegistry([haiku, sonnet, opus, flash, visionModel]);

  it("resolves 'fast' to a model with fast-tier id substring", () => {
    const result = resolveModelByProfile("fast", registry);
    expect(result?.id).toMatch(/haiku|flash|mini|small|nano/i);
  });

  it("resolves 'powerful' to an opus/pro model", () => {
    const result = resolveModelByProfile("powerful", registry);
    expect(result?.id).toMatch(/opus|pro|large|max/i);
  });

  it("resolves 'balanced' to a sonnet/medium model", () => {
    const result = resolveModelByProfile("balanced", registry);
    expect(result?.id).toMatch(/sonnet|medium/i);
  });

  it("resolves 'vision' to a model that accepts image input", () => {
    const result = resolveModelByProfile("vision", registry);
    expect(result?.input).toContain("image");
  });

  it("returns undefined for unknown profile", () => {
    const result = resolveModelByProfile("unicorn-tier", registry);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const result = resolveModelByProfile("", registry);
    expect(result).toBeUndefined();
  });

  it("is case-insensitive for the profile name", () => {
    const result = resolveModelByProfile("FAST", registry);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// buildSkillModelMap
// ---------------------------------------------------------------------------

describe("buildSkillModelMap", () => {
  const opus = makeModel("anthropic", "claude-opus-4-6");
  const haiku = makeModel("anthropic", "claude-haiku-4-5");
  const registry = makeRegistry([opus, haiku]);

  it("resolves explicit model field", () => {
    const entry = makeSkillEntry("my-skill", "/workspace/skills/my-skill/SKILL.md", {
      model: "anthropic/claude-opus-4-6",
    });
    const map = buildSkillModelMap([entry], registry);
    expect(map.size).toBe(1);
    const key = [...map.keys()][0];
    expect(key).toContain("SKILL.md");
    expect(map.get(key)).toMatchObject({ provider: "anthropic", id: "claude-opus-4-6" });
  });

  it("resolves modelProfile field", () => {
    const entry = makeSkillEntry("/workspace/skills/quick/SKILL.md", "quick", {
      modelProfile: "fast",
    });
    const map = buildSkillModelMap([entry], registry);
    expect(map.size).toBe(1);
    expect([...map.values()][0]?.id).toMatch(/haiku|flash|mini|small|nano/i);
  });

  it("skips entry when model not in registry", () => {
    const entry = makeSkillEntry("missing", "/workspace/skills/missing/SKILL.md", {
      model: "openai/gpt-nonexistent",
    });
    const map = buildSkillModelMap([entry], registry);
    expect(map.size).toBe(0);
  });

  it("skips entry when model field is malformed (no slash)", () => {
    const entry = makeSkillEntry("bad", "/workspace/skills/bad/SKILL.md", {
      model: "no-slash-here",
    });
    const map = buildSkillModelMap([entry], registry);
    expect(map.size).toBe(0);
  });

  it("skips entry when modelProfile resolves to nothing", () => {
    const entry = makeSkillEntry("noprofile", "/workspace/skills/noprofile/SKILL.md", {
      modelProfile: "imaginary-tier",
    });
    const map = buildSkillModelMap([entry], registry);
    expect(map.size).toBe(0);
  });

  it("returns empty map when no entries have model metadata", () => {
    const entries = [
      makeSkillEntry("a", "/workspace/skills/a/SKILL.md"),
      makeSkillEntry("b", "/workspace/skills/b/SKILL.md"),
    ];
    const map = buildSkillModelMap(entries, registry);
    expect(map.size).toBe(0);
  });

  it("returns empty map for empty skill entries", () => {
    expect(buildSkillModelMap([], registry).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wrapReadToolWithSkillModelDetect
// ---------------------------------------------------------------------------

describe("wrapReadToolWithSkillModelDetect", () => {
  const opus = makeModel("anthropic", "claude-opus-4-6");
  const skillFilePath = "/workspace/skills/deep/SKILL.md";

  // pi-coding-agent execute signature: (toolCallId, args, signal)
  type ReadExecute = (toolCallId: unknown, args: unknown) => Promise<unknown>;

  function makeReadTool(onExecute?: (toolCallId: unknown, args: unknown) => void): AnyAgentTool {
    return {
      name: "read",
      execute: vi.fn(async (toolCallId: unknown, args: unknown) => {
        onExecute?.(toolCallId, args);
        return "file content";
      }),
    } as unknown as AnyAgentTool;
  }

  it("sets ctx.activeModel when SKILL.md path is in map", async () => {
    const skillModelMap = new Map([[skillFilePath, opus]]);
    const ctx = createActiveSkillModelContext();
    const tool = wrapReadToolWithSkillModelDetect(makeReadTool(), skillModelMap, ctx);

    await (tool.execute as unknown as ReadExecute)("call-1", { path: skillFilePath });
    expect(ctx.activeModel).toMatchObject({ id: "claude-opus-4-6" });
  });

  it("does NOT set ctx.activeModel for a non-SKILL.md path", async () => {
    const skillModelMap = new Map([[skillFilePath, opus]]);
    const ctx = createActiveSkillModelContext();
    const tool = wrapReadToolWithSkillModelDetect(makeReadTool(), skillModelMap, ctx);

    await (tool.execute as unknown as ReadExecute)("call-1", { path: "/workspace/src/foo.ts" });
    expect(ctx.activeModel).toBeUndefined();
  });

  it("does NOT set ctx.activeModel for a SKILL.md path not in map", async () => {
    const skillModelMap = new Map([[skillFilePath, opus]]);
    const ctx = createActiveSkillModelContext();
    const tool = wrapReadToolWithSkillModelDetect(makeReadTool(), skillModelMap, ctx);

    await (tool.execute as unknown as ReadExecute)("call-1", {
      path: "/workspace/skills/other/SKILL.md",
    });
    expect(ctx.activeModel).toBeUndefined();
  });

  it("returns original tool when skillModelMap is empty", () => {
    const original = makeReadTool();
    const result = wrapReadToolWithSkillModelDetect(
      original,
      new Map(),
      createActiveSkillModelContext(),
    );
    expect(result).toBe(original);
  });

  it("still returns the original tool result", async () => {
    const skillModelMap = new Map([[skillFilePath, opus]]);
    const ctx = createActiveSkillModelContext();
    const tool = wrapReadToolWithSkillModelDetect(makeReadTool(), skillModelMap, ctx);

    const result = await (tool.execute as unknown as ReadExecute)("call-1", {
      path: skillFilePath,
    });
    expect(result).toBe("file content");
  });
});

// ---------------------------------------------------------------------------
// wrapStreamFnSkillModelRouter
// ---------------------------------------------------------------------------

describe("wrapStreamFnSkillModelRouter", () => {
  const defaultModel = makeModel("anthropic", "claude-sonnet-4-6");
  const overrideModel = makeModel("anthropic", "claude-opus-4-6");

  it("passes the override model when ctx.activeModel is set", () => {
    const ctx = createActiveSkillModelContext();
    ctx.activeModel = overrideModel;

    const baseFn = vi.fn(() => ({ [Symbol.asyncIterator]: async function* () {} }));
    const wrapped = wrapStreamFnSkillModelRouter(
      baseFn as unknown as Parameters<typeof wrapStreamFnSkillModelRouter>[0],
      ctx,
    );

    wrapped(defaultModel as unknown as Parameters<typeof wrapped>[0], { messages: [] }, {});
    expect(baseFn).toHaveBeenCalledWith(overrideModel, { messages: [] }, {});
  });

  it("passes the original model when ctx.activeModel is undefined", () => {
    const ctx = createActiveSkillModelContext();

    const baseFn = vi.fn(() => ({ [Symbol.asyncIterator]: async function* () {} }));
    const wrapped = wrapStreamFnSkillModelRouter(
      baseFn as unknown as Parameters<typeof wrapStreamFnSkillModelRouter>[0],
      ctx,
    );

    wrapped(defaultModel as unknown as Parameters<typeof wrapped>[0], { messages: [] }, {});
    expect(baseFn).toHaveBeenCalledWith(defaultModel, { messages: [] }, {});
  });
});

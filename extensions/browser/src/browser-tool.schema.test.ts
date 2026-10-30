import { expectDefined } from "@openclaw/normalization-core";
import { projectRuntimeToolInputSchema } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOpenAIToolSchemas } from "openclaw/plugin-sdk/provider-tools";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createBrowserToolSchema, resolveBrowserToolCapabilities } from "./browser-tool.schema.js";
import { ACT_MAX_VIEWPORT_DIMENSION } from "./browser/act-policy.js";
import { resolveBrowserConfig, resolveProfile } from "./browser/config.js";
import { getBrowserProfileCapabilities } from "./browser/profile-capabilities.js";

describe("browser tool schema", () => {
  const fullSchema = createBrowserToolSchema(resolveBrowserToolCapabilities({ canJudge: true }));
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    const dimension = { maximum: ACT_MAX_VIEWPORT_DIMENSION };
    const resize = { width: dimension, height: dimension };
    expect(fullSchema.properties).toMatchObject({ ...resize, request: { properties: resize } });
  });

  it("preserves keyboard guidance within the provider schema budget", () => {
    const tool = { name: "browser", label: "B", description: "B", parameters: fullSchema };
    const [normalized] = normalizeOpenAIToolSchemas({
      provider: "openai",
      modelApi: "openai-chatgpt-responses",
      tools: [{ ...tool, execute: async () => ({ content: [], details: {} }) }],
    });
    const { schema, violations } = projectRuntimeToolInputSchema(normalized?.parameters);
    expect(violations).toEqual([]);
    // Codex strips parameter descriptions above 5,000 bytes after schema normalization.
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(5_000);
    for (const scope of ["properties", "properties.request.properties"]) {
      expect(schema).toHaveProperty(
        `${scope}.key.description`,
        expect.stringContaining("aliases Esc, Return, Del, Ctrl, Cmd"),
      );
    }
  });

  it("hides Playwright-only actions for an existing-session binding", () => {
    const capabilities = resolveBrowserToolCapabilities({
      canJudge: true,
      tabBound: true,
      profileCapabilities: {
        supportsBatchActions: false,
        supportsDownloads: false,
        supportsPdf: false,
        supportsRequests: false,
        supportsErrors: false,
        supportsPageText: false,
        supportsEmulation: false,
      },
    });
    const hidden = [
      "requests",
      "errors",
      "text",
      "judge",
      "emulate",
      "pdf",
      "download",
      "waitfordownload",
    ];
    for (const action of hidden) {
      expect(capabilities.actions).not.toContain(action);
    }
    expect(capabilities.actions).toEqual(expect.arrayContaining(["snapshot", "console"]));
    const schema = createBrowserToolSchema(capabilities);
    for (const act of [schema.properties, schema.properties.request.properties]) {
      expect(act.kind).toMatchObject({
        enum: expect.not.arrayContaining(["batch"]),
        description: expect.not.stringContaining("batch"),
      });
      for (const field of [act.actions, act.stopOnError]) {
        expect(field).toEqual(expect.any(Object));
        expect(field).not.toHaveProperty("description");
      }
    }
  });

  it("advertises only semantic actions for a bound Lightpanda profile", () => {
    const resolved = resolveBrowserConfig({
      profiles: {
        lightweight: { engine: "lightpanda", cdpUrl: "ws://127.0.0.1:9222/", attachOnly: true },
      },
    });
    const profile = expectDefined(resolveProfile(resolved, "lightweight"), "Lightpanda profile");
    const capabilities = resolveBrowserToolCapabilities({
      tabBound: true,
      canJudge: true,
      profileCapabilities: getBrowserProfileCapabilities(profile),
    });
    const schema = createBrowserToolSchema(capabilities);
    expect(Value.Check(schema, { action: "screenshot" })).toBe(false);
    expect(Value.Check(schema, { action: "text" })).toBe(true);
    expect(Value.Check(schema, { action: "judge" })).toBe(true);
    expect(Value.Check(schema, { action: "act", request: { kind: "batch" } })).toBe(false);
    expect(Value.Check(schema, { action: "act", kind: "clickCoords" })).toBe(false);
    expect(schema.properties).not.toHaveProperty("selector");
    expect(Value.Check(schema, { action: "snapshot", snapshotFormat: "aria" })).toBe(false);
    expect(Value.Check(schema, { action: "snapshot", refs: "role" })).toBe(false);
    expect(Value.Check(schema, { action: "snapshot", snapshotFormat: "ai", refs: "aria" })).toBe(
      true,
    );
  });
});

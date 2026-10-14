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
  const BrowserToolSchema = createBrowserToolSchema(resolveBrowserToolCapabilities());
  it("advertises the viewport resize maximum on nested and flattened act params", () => {
    for (const scope of ["properties", "properties.request.properties"]) {
      for (const dimension of ["width", "height"]) {
        expect(BrowserToolSchema).toHaveProperty(
          `${scope}.${dimension}.maximum`,
          ACT_MAX_VIEWPORT_DIMENSION,
        );
      }
    }
  });

  it("preserves keyboard guidance within the provider schema budget", () => {
    const normalized = normalizeOpenAIToolSchemas({
      provider: "openai",
      modelApi: "openai-chatgpt-responses",
      tools: [
        {
          name: "browser",
          label: "Browser",
          description: "Browser",
          parameters: BrowserToolSchema,
          execute: async () => ({ content: [], details: {} }),
        },
      ],
    });
    const projection = projectRuntimeToolInputSchema(normalized[0]?.parameters);
    expect(projection.violations).toEqual([]);
    // Codex strips parameter descriptions above 5,000 bytes after schema normalization.
    expect(Buffer.byteLength(JSON.stringify(projection.schema))).toBeLessThanOrEqual(5_000);
    expect(projection.schema).toHaveProperty(
      "properties.key.description",
      expect.stringContaining("aliases Esc, Return, Del, Ctrl, Cmd"),
    );
    expect(projection.schema).toHaveProperty(
      "properties.request.properties.key.description",
      expect.stringContaining("aliases Esc, Return, Del, Ctrl, Cmd"),
    );
  });

  it("hides Playwright-only actions for an existing-session binding", () => {
    const capabilities = resolveBrowserToolCapabilities({
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
    for (const action of [
      "requests",
      "errors",
      "text",
      "emulate",
      "pdf",
      "download",
      "waitfordownload",
    ]) {
      expect(capabilities.actions).not.toContain(action);
    }
    expect(capabilities.actions).toContain("snapshot");
    expect(capabilities.actions).toContain("console");
    const schema = createBrowserToolSchema(capabilities);
    for (const scope of ["properties", "properties.request.properties"]) {
      expect(schema).toHaveProperty(`${scope}.kind.enum`, expect.not.arrayContaining(["batch"]));
      expect(schema).toHaveProperty(
        `${scope}.kind.description`,
        expect.not.stringContaining("batch"),
      );
      expect(schema).toHaveProperty(`${scope}.actions`);
      expect(schema).toHaveProperty(`${scope}.stopOnError`);
      expect(schema).not.toHaveProperty(`${scope}.actions.description`);
      expect(schema).not.toHaveProperty(`${scope}.stopOnError.description`);
    }
  });

  it("advertises only semantic actions for a bound Lightpanda profile", () => {
    const profile = expectDefined(
      resolveProfile(
        resolveBrowserConfig({
          profiles: {
            lightweight: {
              engine: "lightpanda",
              cdpUrl: "ws://127.0.0.1:9222/",
              attachOnly: true,
            },
          },
        }),
        "lightweight",
      ),
      "Lightpanda profile",
    );
    const capabilities = resolveBrowserToolCapabilities({
      tabBound: true,
      profileCapabilities: getBrowserProfileCapabilities(profile),
    });
    const schema = createBrowserToolSchema(capabilities);
    expect(Value.Check(schema, { action: "screenshot" })).toBe(false);
    expect(Value.Check(schema, { action: "text" })).toBe(true);
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

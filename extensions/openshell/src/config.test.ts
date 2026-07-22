// Openshell tests cover config plugin behavior.
import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createOpenShellPluginConfigSchema, resolveOpenShellPluginConfig } from "./config.js";

describe("openshell plugin config", () => {
  it("applies defaults", () => {
    expect(resolveOpenShellPluginConfig(undefined)).toEqual({
      mode: "mirror",
      command: "openshell",
      gateway: undefined,
      gatewayEndpoint: undefined,
      from: "openclaw",
      policy: undefined,
      providers: [],
      gpu: false,
      autoProviders: true,
      remoteWorkspaceDir: "/sandbox",
      remoteAgentWorkspaceDir: "/agent",
      timeoutMs: 120_000,
      env: {},
    });
  });

  it("accepts remote mode", () => {
    expect(resolveOpenShellPluginConfig({ mode: "remote" }).mode).toBe("remote");
  });

  it("rejects relative remote paths", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        remoteWorkspaceDir: "sandbox",
      }),
    ).toThrow("OpenShell remoteWorkspaceDir must be absolute");
  });

  it("rejects remote paths outside managed sandbox roots", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        remoteWorkspaceDir: "/tmp/victim",
      }),
    ).toThrow("OpenShell remoteWorkspaceDir must stay under /sandbox or /agent");
  });

  it("normalizes managed sandbox subpaths", () => {
    expect(
      resolveOpenShellPluginConfig({
        remoteWorkspaceDir: "/sandbox/../sandbox/project",
        remoteAgentWorkspaceDir: "/agent/./session",
      }),
    ).toEqual({
      mode: "mirror",
      command: "openshell",
      gateway: undefined,
      gatewayEndpoint: undefined,
      from: "openclaw",
      policy: undefined,
      providers: [],
      gpu: false,
      autoProviders: true,
      remoteWorkspaceDir: "/sandbox/project",
      remoteAgentWorkspaceDir: "/agent/session",
      timeoutMs: 120_000,
      env: {},
    });
  });

  it("rejects unknown mode", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        mode: "bogus",
      }),
    ).toThrow("mode must be one of mirror, remote");
  });

  it("rejects timeouts beyond Node's safe timer range", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        timeoutSeconds: 2_147_001,
      }),
    ).toThrow("timeoutSeconds must be a number <= 2147000");
  });

  it("accepts env vars", () => {
    expect(
      resolveOpenShellPluginConfig({
        env: { FOO: "bar", BAZ: "qux" },
      }).env,
    ).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("defaults env to empty object", () => {
    expect(resolveOpenShellPluginConfig({}).env).toEqual({});
  });

  it("rejects env keys with leading whitespace", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        env: { " FOO": "bar" },
      }),
    ).toThrow("has surrounding whitespace");
  });

  it("rejects env keys with trailing whitespace", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        env: { "FOO ": "bar" },
      }),
    ).toThrow("has surrounding whitespace");
  });

  it("rejects env keys with OPENSHELL_ prefix", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        env: { OPENSHELL_API_KEY: "secret" },
      }),
    ).toThrow("reserved OPENSHELL_ prefix");
  });

  it("rejects env keys that are not valid env var names", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        env: { "123invalid": "value" },
      }),
    ).toThrow("not a valid environment variable name");
  });

  it("rejects env keys with special characters", () => {
    expect(() =>
      resolveOpenShellPluginConfig({
        env: { "FOO-BAR": "value" },
      }),
    ).toThrow("not a valid environment variable name");
  });

  it("validates env as an object of string values through the manifest json schema", () => {
    const configSchema = createOpenShellPluginConfigSchema().jsonSchema;
    const properties = (configSchema as Record<string, unknown>).properties as
      | Record<string, unknown>
      | undefined;
    const envProp = properties?.env as Record<string, unknown> | undefined;
    expect(envProp?.type).toBe("object");
    expect((envProp?.additionalProperties as Record<string, unknown>)?.type).toBe("string");

    // Manifest validates value types; runtime .superRefine handles key-level rules
    // (no leading/trailing whitespace, no OPENSHELL_ prefix, valid shell identifiers).
  });

  it("catches invalid env keys through the manifest propertyNames schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: { properties?: Record<string, unknown> } };
    const envSchema = manifest.configSchema?.properties?.env as Record<string, unknown> | undefined;
    expect(envSchema?.propertyNames).toBeDefined();

    // Validate that the manifest rejects keys via propertyNames pattern.
    // The pattern rejects empty strings, OPENSHELL_ prefix, and non-identifier chars.
    const pattern = new RegExp((envSchema?.propertyNames as { pattern?: string })?.pattern ?? "");
    expect(pattern.test("")).toBe(false);
    expect(pattern.test("OPENSHELL_KEY")).toBe(false);
    expect(pattern.test("FOO-BAR")).toBe(false);
    expect(pattern.test("123invalid")).toBe(false);
    expect(pattern.test("VALID_KEY")).toBe(true);
    expect(pattern.test("MODEL_NAME")).toBe(true);
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    // normalizeJsonSchema strips propertyNames, so strip it from the
    // manifest copy before comparing — the gap is intentional.
    const exported = structuredClone(createOpenShellPluginConfigSchema().jsonSchema) as Record<
      string,
      unknown
    >;
    const manifestCopy = structuredClone(manifest.configSchema) as Record<string, unknown>;

    const envProp = (manifestCopy.properties as Record<string, unknown> | undefined)?.env as
      | Record<string, unknown>
      | undefined;
    if (envProp) {
      delete envProp.propertyNames;
    }

    expect(exported).toEqual(manifestCopy);
  });
});

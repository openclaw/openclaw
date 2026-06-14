// sbx tests cover config plugin behavior.
import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createSbxPluginConfigSchema, resolveSbxPluginConfig } from "./config.js";

describe("sbx plugin config", () => {
  it("applies defaults", () => {
    expect(resolveSbxPluginConfig(undefined)).toEqual({
      command: "sbx",
      agent: "shell",
      template: undefined,
      cpus: undefined,
      memory: undefined,
      user: undefined,
      clone: false,
      timeoutMs: 120_000,
    });
  });

  it("resolves provided values", () => {
    expect(
      resolveSbxPluginConfig({
        command: "/usr/local/bin/sbx",
        agent: "claude",
        template: "ghcr.io/example/image:tag",
        cpus: 4,
        memory: "8g",
        user: "root",
        clone: true,
        timeoutSeconds: 180,
      }),
    ).toEqual({
      command: "/usr/local/bin/sbx",
      agent: "claude",
      template: "ghcr.io/example/image:tag",
      cpus: 4,
      memory: "8g",
      user: "root",
      clone: true,
      timeoutMs: 180_000,
    });
  });

  it("rejects empty command", () => {
    expect(() => resolveSbxPluginConfig({ command: "  " })).toThrow(
      "command must be a non-empty string",
    );
  });

  it("rejects negative cpus", () => {
    expect(() => resolveSbxPluginConfig({ cpus: -1 })).toThrow("cpus must be a number >= 0");
  });

  it("rejects timeouts beyond Node's safe timer range", () => {
    expect(() => resolveSbxPluginConfig({ timeoutSeconds: 2_147_001 })).toThrow(
      "timeoutSeconds must be a number <= 2147000",
    );
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createSbxPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});

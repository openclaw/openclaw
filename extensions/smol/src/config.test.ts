import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createSmolPluginConfigSchema, resolveSmolPluginConfig } from "./config.js";

describe("smol plugin config", () => {
  it("applies defaults", () => {
    expect(resolveSmolPluginConfig(undefined)).toEqual({
      command: "smol",
      image: "python:3.12-slim",
      cpus: 2,
      memoryMb: 2048,
      workdir: undefined,
      branchable: true,
      timeoutMs: 120_000,
    });
  });

  it("normalizes the machine workdir and converts the timeout to milliseconds", () => {
    expect(
      resolveSmolPluginConfig({
        command: "/opt/smol/bin/smol",
        image: "debian:bookworm",
        cpus: 4,
        memoryMb: 4096,
        workdir: "/work//project/",
        branchable: false,
        timeoutSeconds: 30,
      }),
    ).toEqual({
      command: "/opt/smol/bin/smol",
      image: "debian:bookworm",
      cpus: 4,
      memoryMb: 4096,
      workdir: "/work/project/",
      branchable: false,
      timeoutMs: 30_000,
    });
  });

  it("rejects a relative machine workdir", () => {
    expect(createSmolPluginConfigSchema().safeParse?.({ workdir: "project" }).success).toBe(false);
    expect(() => resolveSmolPluginConfig({ workdir: "project" })).toThrow(
      "smol workdir must be an absolute path inside the machine",
    );
  });

  it("rejects machine sizes the engine cannot honor", () => {
    expect(() => resolveSmolPluginConfig({ cpus: 0 })).toThrow("cpus must be an integer >= 1");
    expect(() => resolveSmolPluginConfig({ cpus: 1.5 })).toThrow("cpus must be an integer");
    expect(() => resolveSmolPluginConfig({ memoryMb: 128 })).toThrow(
      "memoryMb must be an integer >= 256",
    );
  });

  it("rejects unknown keys so typos surface instead of silently keeping defaults", () => {
    expect(createSmolPluginConfigSchema().safeParse?.({ memory: 4096 }).success).toBe(false);
  });

  it("rejects timeouts beyond Node's safe timer range", () => {
    expect(() => resolveSmolPluginConfig({ timeoutSeconds: 2_147_001 })).toThrow(
      "timeoutSeconds must be a number <= 2147000",
    );
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };
    expect(createSmolPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});

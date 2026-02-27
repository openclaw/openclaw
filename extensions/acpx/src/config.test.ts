import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACPX_BUNDLED_BIN,
  createAcpxPluginConfigSchema,
  resolveAcpxPluginConfig,
} from "./config.js";

describe("acpx plugin config parsing", () => {
  it("resolves a strict plugin-local acpx command", () => {
    const resolved = resolveAcpxPluginConfig({
      rawConfig: {
        cwd: "/tmp/workspace",
      },
      workspaceDir: "/tmp/workspace",
    });

    expect(resolved.command).toBe(ACPX_BUNDLED_BIN);
    expect(resolved.cwd).toBe(path.resolve("/tmp/workspace"));
  });

  it("rejects command overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          command: "acpx-custom",
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: command");
  });

  it("rejects commandArgs overrides", () => {
    expect(() =>
      resolveAcpxPluginConfig({
        rawConfig: {
          commandArgs: ["--foo"],
        },
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow("unknown config key: commandArgs");
  });

  it("schema rejects empty cwd", () => {
    const schema = createAcpxPluginConfigSchema();
    if (!schema.safeParse) {
      throw new Error("acpx config schema missing safeParse");
    }
    const parsed = schema.safeParse({ cwd: "   " });

    expect(parsed.success).toBe(false);
  });
});

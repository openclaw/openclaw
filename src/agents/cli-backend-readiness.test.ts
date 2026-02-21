import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveCliBackendReadiness } from "./cli-backend-readiness.js";

describe("resolveCliBackendReadiness", () => {
  it("returns backend_config_error when backend command is empty", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "   ",
            },
          },
        },
      },
    } as OpenClawConfig;

    const readiness = resolveCliBackendReadiness({
      provider: "claude-cli",
      cfg,
    });

    expect(readiness.status).toBe("backend_config_error");
    expect(readiness.detail).toContain("missing or invalid");
  });

  it("returns backend_config_error when command includes inline args", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "claude-cli": {
              command: "claude --output-format json",
            },
          },
        },
      },
    } as OpenClawConfig;

    const readiness = resolveCliBackendReadiness({
      provider: "claude-cli",
      cfg,
    });

    expect(readiness.status).toBe("backend_config_error");
    expect(readiness.hint).toContain(".args");
  });

  it("returns ready for absolute executable command path", () => {
    const cfg = {
      agents: {
        defaults: {
          cliBackends: {
            "custom-cli": {
              command: process.execPath,
            },
          },
        },
      },
    } as OpenClawConfig;

    const readiness = resolveCliBackendReadiness({
      provider: "custom-cli",
      cfg,
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.resolvedPath).toBe(process.execPath);
  });
});

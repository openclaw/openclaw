/** Tests pure Code Mode config without loading the guest or test runtime. */

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";

describe("Code Mode configuration", () => {
  it("model on overrides global off", () => {
    const cfg: OpenClawConfig = {
      tools: { codeMode: { enabled: false, timeoutMs: 1234, maxOutputBytes: 4096 } },
      agents: {
        defaults: { models: { "test/model-a": { codeMode: true } } },
        entries: {
          ops: {
            tools: { codeMode: { timeoutMs: 2345 } },
            models: { "test/model-a": { alias: "A" } },
          },
        },
      },
    };
    expect(
      resolveCodeModeConfig(cfg, "ops", { provider: "test", modelId: "model-a" }),
    ).toMatchObject({ enabled: true, timeoutMs: 2345, maxOutputBytes: 4096 });
    expect(
      resolveCodeModeConfig(cfg, "ops", { provider: "test", modelId: "model-b" }).enabled,
    ).toBe(false);
  });

  it("resolves object config defaults", () => {
    expect(resolveCodeModeConfig()).toMatchObject({ enabled: "auto", executor: "node" });
    expect(resolveCodeModeConfig({ tools: { codeMode: true } })).toMatchObject({
      enabled: true,
      executor: "node",
    });
    const resolved = resolveCodeModeConfig({
      tools: {
        codeMode: {
          timeoutMs: 1234,
        },
      },
    } as never);
    expect(resolved.enabled).toBe(false);
    expect(resolveCodeModeConfig({ tools: { codeMode: { enabled: true } } } as never).enabled).toBe(
      true,
    );
    expect(resolved.executor).toBe("node");
    expect(resolved.mode).toBe("only");
    expect(resolved.timeoutMs).toBe(1234);
    const limitedSearch = resolveCodeModeConfig({
      tools: {
        codeMode: {
          enabled: true,
          maxSearchLimit: 3,
        },
      },
    } as never);
    expect(limitedSearch.searchDefaultLimit).toBe(3);
    expect(limitedSearch.maxSearchLimit).toBe(3);
  });

  it("inherits the executor independently of activation and overrides it per agent", () => {
    const config: OpenClawConfig = {
      tools: { codeMode: { enabled: "auto", executor: "quickjs", timeoutMs: 2500 } },
      agents: {
        entries: {
          inherited: { tools: { codeMode: true } },
          fast: { tools: { codeMode: { executor: "node" } } },
        },
      },
    };

    expect(resolveCodeModeConfig(config, "inherited")).toMatchObject({
      enabled: true,
      executor: "quickjs",
      timeoutMs: 2500,
    });
    expect(resolveCodeModeConfig(config, "fast")).toMatchObject({
      enabled: "auto",
      executor: "node",
      timeoutMs: 2500,
    });
    expect(resolveCodeModeConfig(config, "missing").executor).toBe("quickjs");
  });

  it("rejects an unsupported executor instead of falling back to Node", () => {
    expect(() =>
      resolveCodeModeConfig({ tools: { codeMode: { executor: "unsupported" } } } as never),
    ).toThrow('Code Mode executor must be "node" or "quickjs".');
  });
});

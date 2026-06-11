// Memory Host SDK tests cover config utils behavior.
import { describe, expect, it } from "vitest";
import { parseDurationMs, resolveAgentWorkspaceDir } from "./config-utils.js";
import type { OpenClawConfig } from "./config-utils.js";

describe("resolveAgentWorkspaceDir", () => {
  it("non-default agent uses hyphenated fallback under agents.defaults.workspace", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true }],
      },
    };
    expect(resolveAgentWorkspaceDir(cfg, "main")).toBe("/shared-ws-main");
  });

  it("default agent uses agents.defaults.workspace directly", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/shared-ws" },
        list: [{ id: "main" }, { id: "work", default: true }],
      },
    };
    expect(resolveAgentWorkspaceDir(cfg, "work")).toBe("/shared-ws");
  });
});

describe("parseDurationMs", () => {
  it("parses decimal durations into milliseconds", () => {
    expect(parseDurationMs("1.5s")).toBe(1_500);
    expect(parseDurationMs("1h30m")).toBe(5_400_000);
  });

  it("rejects unsafe millisecond results", () => {
    expect(() => parseDurationMs("9007199254740993ms")).toThrow(/invalid duration/u);
    expect(() => parseDurationMs("9007199254740990ms10ms")).toThrow(/invalid duration/u);
  });
});

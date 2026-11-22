import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyConfiguredClaudeCliPlacement } from "./configured-node-placement.js";

const placed: OpenClawConfig = { tools: { exec: { claudeCliHost: "node", node: "node-a" } } };

function place(
  config: OpenClawConfig,
  entry: { execHost?: string; execNode?: string } | undefined,
) {
  return applyConfiguredClaudeCliPlacement({
    config,
    agentId: "main",
    backendId: "claude-cli",
    sessionEntry: entry,
  });
}

describe("applyConfiguredClaudeCliPlacement", () => {
  it("returns the same entry without the opt-in, including for exec host node", () => {
    const entry = { execHost: "gateway" };
    expect(place({}, entry)).toBe(entry);
    expect(place({ tools: { exec: { host: "node", node: "node-a" } } }, entry)).toBe(entry);
    expect(place({ tools: { exec: { claudeCliHost: "gateway", node: "node-a" } } }, entry)).toBe(
      entry,
    );
    expect(place({}, undefined)).toBeUndefined();
  });

  it("leaves other CLI backends alone", () => {
    const entry = {};
    expect(
      applyConfiguredClaudeCliPlacement({
        config: placed,
        agentId: "main",
        backendId: "codex-cli",
        sessionEntry: entry,
      }),
    ).toBe(entry);
  });

  it("places the session on the configured node, keeping its node cwd", () => {
    expect(place(placed, { execHost: "gateway" })).toEqual({
      execHost: "node",
      execNode: "node-a",
    });
    const bound = { execHost: "node", execNode: "node-a", execCwd: "/work" };
    expect(place(placed, bound)).toBe(bound);
    expect(place(placed, { execNode: " node-a " })).toEqual({
      execHost: "node",
      execNode: "node-a",
    });
  });

  it("takes the agent's tools.exec over the global one", () => {
    const config: OpenClawConfig = {
      tools: { exec: { claudeCliHost: "node", node: "node-a" } },
      agents: {
        entries: {
          main: { tools: { exec: { node: "node-b" } } },
          ops: { tools: { exec: { claudeCliHost: "gateway" } } },
        },
      },
    };
    expect(place(config, {})).toEqual({ execHost: "node", execNode: "node-b" });
    const entry = {};
    expect(
      applyConfiguredClaudeCliPlacement({
        config,
        agentId: "ops",
        backendId: "claude-cli",
        sessionEntry: entry,
      }),
    ).toBe(entry);
  });

  it("refuses a run it cannot place instead of starting it on the Gateway", () => {
    expect(() => place({ tools: { exec: { claudeCliHost: "node" } } }, {})).toThrow(
      "tools.exec.node is not set",
    );
    expect(() => place(placed, undefined)).toThrow("has no session to place on the node");
    expect(() => place(placed, { execHost: "node", execNode: "node-b" })).toThrow(
      'This session is bound to node "node-b"',
    );
  });
});

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { __testing } from "./pi-tools.js";

const { resolveExecConfig } = __testing;

describe("resolveExecConfig", () => {
  it("returns global exec config when no agentId is provided", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          safeBins: ["/usr/bin/echo"],
        },
      },
    };
    const result = resolveExecConfig(cfg, undefined);
    expect(result.host).toBe("gateway");
    expect(result.security).toBe("allowlist");
    expect(result.safeBins).toEqual(["/usr/bin/echo"]);
  });

  it("returns global exec config when agent has no exec override", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "gateway",
          security: "deny",
        },
      },
      agents: {
        list: [{ id: "main", workspace: "~/openclaw" }],
      },
    };
    const result = resolveExecConfig(cfg, "main");
    expect(result.host).toBe("gateway");
    expect(result.security).toBe("deny");
  });

  it("prefers agent-specific exec config over global", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "sandbox",
          security: "deny",
          safeBins: ["/global/bin"],
          timeoutSec: 30,
        },
      },
      agents: {
        list: [
          {
            id: "team",
            workspace: "~/team",
            tools: {
              exec: {
                host: "gateway",
                security: "allowlist",
                safeBins: ["/agent/bin"],
              },
            },
          },
        ],
      },
    };
    const result = resolveExecConfig(cfg, "team");
    expect(result.host).toBe("gateway");
    expect(result.security).toBe("allowlist");
    expect(result.safeBins).toEqual(["/agent/bin"]);
    // Falls back to global for fields not overridden by agent
    expect(result.timeoutSec).toBe(30);
  });

  it("falls back to global when agent does not override a field", () => {
    const cfg: OpenClawConfig = {
      tools: {
        exec: {
          host: "sandbox",
          security: "deny",
          ask: "on-miss",
          node: "remote-node",
        },
      },
      agents: {
        list: [
          {
            id: "restricted",
            workspace: "~/restricted",
            tools: {
              exec: {
                security: "allowlist",
              },
            },
          },
        ],
      },
    };
    const result = resolveExecConfig(cfg, "restricted");
    expect(result.security).toBe("allowlist");
    expect(result.host).toBe("sandbox");
    expect(result.ask).toBe("on-miss");
    expect(result.node).toBe("remote-node");
  });

  it("handles undefined config gracefully", () => {
    const result = resolveExecConfig(undefined, "main");
    expect(result.host).toBeUndefined();
    expect(result.security).toBeUndefined();
  });
});

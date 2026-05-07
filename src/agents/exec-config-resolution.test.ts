import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExecConfig } from "./exec-config-resolution.js";

describe("resolveExecConfig", () => {
  it("returns all-undefined fields for an empty config", () => {
    const result = resolveExecConfig({});
    expect(result).toEqual({
      host: undefined,
      security: undefined,
      ask: undefined,
      node: undefined,
      pathPrepend: undefined,
      safeBins: undefined,
      strictInlineEval: undefined,
      safeBinTrustedDirs: undefined,
      safeBinProfiles: undefined,
      backgroundMs: undefined,
      timeoutSec: undefined,
      approvalRunningNoticeMs: undefined,
      cleanupMs: undefined,
      notifyOnExit: undefined,
      notifyOnExitEmptySuccess: undefined,
      applyPatch: undefined,
    });
  });

  it("forwards global tools.exec values when no agent override is given", () => {
    const cfg = {
      tools: {
        exec: {
          host: "gateway",
          security: "full",
          ask: "off",
          node: "node-a",
          pathPrepend: ["/usr/local/bin"],
          safeBins: ["/usr/bin/uptime"],
          safeBinTrustedDirs: ["/usr/bin"],
          strictInlineEval: true,
          backgroundMs: 5_000,
          timeoutSec: 60,
          approvalRunningNoticeMs: 1_000,
          cleanupMs: 30_000,
          notifyOnExit: true,
          notifyOnExitEmptySuccess: false,
          applyPatch: { allowModels: ["openai/gpt-5.5"] },
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg });

    expect(result).toMatchObject({
      host: "gateway",
      security: "full",
      ask: "off",
      node: "node-a",
      pathPrepend: ["/usr/local/bin"],
      safeBins: ["/usr/bin/uptime"],
      safeBinTrustedDirs: ["/usr/bin"],
      strictInlineEval: true,
      backgroundMs: 5_000,
      timeoutSec: 60,
      approvalRunningNoticeMs: 1_000,
      cleanupMs: 30_000,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: false,
      applyPatch: { allowModels: ["openai/gpt-5.5"] },
    });
  });

  it("lets agent-level tools.exec override matching global fields", () => {
    const cfg = {
      tools: {
        exec: {
          host: "gateway",
          security: "allowlist",
          node: "global-node",
          timeoutSec: 60,
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              exec: {
                host: "node",
                security: "full",
                node: "agent-node",
                timeoutSec: 120,
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg, agentId: "main" });

    expect(result.host).toBe("node");
    expect(result.security).toBe("full");
    expect(result.node).toBe("agent-node");
    expect(result.timeoutSec).toBe(120);
  });

  it("falls back to global fields the agent override does not specify", () => {
    const cfg = {
      tools: {
        exec: {
          host: "gateway",
          security: "full",
          node: "global-node",
          timeoutSec: 60,
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              exec: {
                ask: "always",
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg, agentId: "main" });

    expect(result.ask).toBe("always");
    // unspecified at agent level — global wins
    expect(result.host).toBe("gateway");
    expect(result.security).toBe("full");
    expect(result.node).toBe("global-node");
    expect(result.timeoutSec).toBe(60);
  });

  it("ignores agent overrides when no agentId is supplied", () => {
    const cfg = {
      tools: {
        exec: {
          host: "gateway",
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              exec: {
                host: "node",
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg });

    expect(result.host).toBe("gateway");
  });

  it("merges global and agent safeBinProfiles with agent winning on key collision", () => {
    const cfg = {
      tools: {
        exec: {
          safeBinProfiles: {
            python3: { minPositional: 1, maxPositional: 4 },
            node: { allowedValueFlags: ["--flag-from-global"] },
          },
        },
      },
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              exec: {
                safeBinProfiles: {
                  python3: { maxPositional: 8 },
                  uptime: { minPositional: 0, maxPositional: 0 },
                },
              },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg, agentId: "main" });

    expect(result.safeBinProfiles).toBeDefined();
    // agent override replaces the global key entirely (last-write merge)
    expect(result.safeBinProfiles?.python3).toMatchObject({ maxPositional: 8 });
    expect(result.safeBinProfiles?.python3?.minPositional).toBeUndefined();
    // unique to global, preserved
    expect(result.safeBinProfiles?.node).toMatchObject({
      allowedValueFlags: ["--flag-from-global"],
    });
    // unique to agent, included
    expect(result.safeBinProfiles?.uptime).toMatchObject({
      minPositional: 0,
      maxPositional: 0,
    });
  });

  it("returns undefined safeBinProfiles when neither global nor agent set them", () => {
    const cfg = {
      tools: {
        exec: {
          host: "gateway",
        },
      },
    } as unknown as OpenClawConfig;

    const result = resolveExecConfig({ cfg });

    expect(result.safeBinProfiles).toBeUndefined();
  });
});

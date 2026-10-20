import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as execApprovals from "../infra/exec-approvals.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  resolveExecDefaults,
  resolveExecDefaultsAsync,
  resolveNodeExecEligibility,
  resolveNodeExecEligibilityAsync,
} from "./exec-defaults.js";

const execStoreDirs = useSessionStoreTempDirs(afterAll, "openclaw-required-exec-");

function withDefaultAgent(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    agents: { ...config.agents, entries: { main: {} } },
  };
}

function resolve(params: Parameters<typeof resolveExecDefaults>[0]) {
  return resolveExecDefaults({ sandboxAvailable: false, ...params });
}
const fullFloors = {
  version: 1 as const,
  defaults: { security: "full" as const, ask: "always" as const },
  agents: {},
};
const emptyApprovals = { version: 1 as const, agents: {} };

describe("resolveExecDefaults", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(execApprovals, "loadExecApprovals").mockReturnValue(emptyApprovals);
    vi.spyOn(execApprovals, "loadExecApprovalsReadOnlyAsync").mockResolvedValue(emptyApprovals);
  });

  it.each([
    { host: "gateway", sessionKey: "agent:main:guest" },
    { host: "node", sessionKey: "global" },
  ] as const)(
    "keeps required $sessionKey sandboxed and hides nodes despite configured host=$host",
    async ({ host, sessionKey }) => {
      const storePath = path.join(execStoreDirs.make(), "sessions.json");
      const sessionEntry = {
        sessionId: "guest-session",
        updatedAt: 1,
        sandbox: "required" as const,
      };
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, sessionEntry);
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        agents: {
          ownership: "explicit",
          defaults: { sandbox: { mode: "off" } },
          entries: { main: {}, worker: {} },
        },
        tools: { exec: { host } },
      };
      const owner = { cfg, agentId: "main", sandboxAvailable: true };
      const expected = { host: "auto", effectiveHost: "sandbox", canRequestNode: false };
      expect(await resolveExecDefaultsAsync({ ...owner, sessionKey })).toMatchObject(expected);
      expect(resolve({ ...owner, sessionEntry })).toMatchObject(expected);
      expect(
        (await resolveExecDefaultsAsync({ ...owner, sessionKey, elevatedRequested: true }))
          .effectiveHost,
      ).toBe("sandbox");
      expect(resolveNodeExecEligibility({ ...owner, sessionEntry }).canExec).toBe(false);
      expect(await resolveNodeExecEligibilityAsync({ ...owner, sessionKey })).toEqual({
        canExec: false,
      });
      expect(execApprovals.loadExecApprovalsReadOnlyAsync).not.toHaveBeenCalled();
    },
  );

  it("applies host approval floors prepared asynchronously", async () => {
    vi.mocked(execApprovals.loadExecApprovalsReadOnlyAsync).mockResolvedValue({
      version: 1,
      defaults: { security: "deny", ask: "always" },
      agents: {},
    });

    expect(
      await resolveExecDefaultsAsync({
        cfg: withDefaultAgent({ tools: { exec: { host: "gateway", mode: "full" } } }),
      }),
    ).toMatchObject({ effectiveHost: "gateway", security: "deny", ask: "always" });
  });

  it("uses isolated sandbox policy for global exec defaults", async () => {
    const storeRoot = execStoreDirs.make();
    const cfg: OpenClawConfig = {
      session: { store: path.join(storeRoot, "{agentId}", "sessions.json") },
      agents: {
        ownership: "explicit",
        entries: {
          isolated: { sandbox: { mode: "all" } },
          direct: { sandbox: { mode: "off" } },
        },
      },
    };
    const params = { cfg, agentId: "isolated", sessionKey: "global" };

    expect(await resolveExecDefaultsAsync(params)).toMatchObject({
      effectiveHost: "sandbox",
      canRequestNode: false,
    });
    expect(await resolveNodeExecEligibilityAsync(params)).toEqual({ canExec: false });
  });

  it("ignores host approval defaults when auto resolves to sandbox", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue(fullFloors);

    const defaults = resolve({
      cfg: withDefaultAgent({ tools: { exec: { host: "auto" } } }),
      sandboxAvailable: true,
    });

    // Sandbox mode is intentionally self-contained: gateway approval floors
    // must not leak into the local deny-by-default sandbox contract.
    expect(defaults).toMatchObject({
      host: "auto",
      effectiveHost: "sandbox",
      canRequestNode: false,
      mode: "deny",
      security: "deny",
      ask: "off",
    });
    expect(execApprovals.loadExecApprovals).not.toHaveBeenCalled();
  });

  it("reports host approval floors after normalized exec modes", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      defaults: {
        security: "deny",
        ask: "off",
      },
      agents: {},
    });

    // Approval floors clamp normalized mode upward/downward after config mode
    // mapping so persisted host policy remains the final safety boundary.
    expect(
      resolveExecDefaults({
        cfg: withDefaultAgent({
          tools: {
            exec: {
              mode: "auto",
            },
          },
        }),
        sandboxAvailable: false,
      }),
    ).toMatchObject({
      mode: "deny",
      security: "deny",
      ask: "on-miss",
    });
  });

  it("reports agent-scoped host approval floors", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue({
      version: 1,
      agents: { "agent-a": { security: "full", ask: "always" } },
    });

    expect(
      resolve({
        cfg: {
          tools: { exec: { mode: "full" } },
          agents: { entries: { "agent-a": {} } },
        },
        agentId: "agent-a",
      }),
    ).toMatchObject({
      mode: "ask",
      security: "full",
      ask: "always",
    });
  });

  it("keeps an explicit full session at full/off despite host approval floors", () => {
    vi.mocked(execApprovals.loadExecApprovals).mockReturnValue(fullFloors);

    expect(
      resolve({
        cfg: withDefaultAgent({}),
        sessionEntry: { permissionMode: "full" },
      }),
    ).toMatchObject({
      mode: "full",
      security: "full",
      ask: "off",
    });
  });

  it.each([
    ["guarded", { ask: "always" }, { security: "allowlist", ask: "always", mode: "ask" }],
    ["guarded", { mode: "deny" }, { security: "deny", ask: "on-miss", mode: "deny" }],
    ["guarded", { mode: "full" }, { security: "allowlist", ask: "on-miss", mode: "ask" }],
    ["workspace", { mode: "auto" }, { security: "allowlist", ask: "on-miss", mode: "auto" }],
    [
      "workspace",
      { mode: "auto", security: "deny", ask: "always" },
      { security: "deny", ask: "always", mode: "deny" },
    ],
  ] as const)("only tightens %s with %j", (permissionMode, execOverrides, expected) => {
    expect(resolve({ sessionEntry: { permissionMode }, execOverrides })).toMatchObject(expected);
  });

  it.each([
    [
      { mode: "full", security: "allowlist" },
      { security: "deny", ask: "always", mode: "deny" },
    ],
    [
      { mode: "full", ask: "on-miss" },
      { security: "full", ask: "on-miss", mode: "full" },
    ],
  ] as const)("bounds full sessions with host floors for %j", (execOverrides, expected) => {
    expect(
      resolve({
        sessionEntry: { permissionMode: "full" },
        execOverrides,
        execApprovals: { version: 1, defaults: { security: "deny", ask: "always" } },
      }),
    ).toMatchObject(expected);
  });

  it("uses the explicit agent owner for an unscoped session", () => {
    expect(
      resolve({
        cfg: {
          tools: { exec: { security: "full", ask: "off" } },
          agents: {
            entries: {
              main: {},
              ops: { tools: { exec: { security: "deny", ask: "always" } } },
            },
          },
        },
        agentId: "ops",
      }),
    ).toMatchObject({
      security: "deny",
      ask: "always",
    });
  });

  it("blocks node skill eligibility for deny policy and preserves node bindings", () => {
    expect(
      resolveNodeExecEligibility({
        cfg: withDefaultAgent({
          tools: { exec: { host: "node", mode: "deny", node: "build-mac" } },
        }),
      }),
    ).toEqual({ canExec: false, node: "build-mac" });
  });

  it("blocks node skill eligibility when the gateway denies system.run", () => {
    expect(
      resolveNodeExecEligibility({
        cfg: withDefaultAgent({
          gateway: { nodes: { commands: { deny: [" system.run "] } } },
          tools: { exec: { host: "node", mode: "full" } },
        }),
      }),
    ).toEqual({ canExec: false });
  });
});

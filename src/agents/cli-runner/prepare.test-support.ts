import { expect, it, vi } from "vitest";
import {
  replaceSessionEntrySync,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SessionManager } from "../sessions/session-manager.js";
import type { RunCliAgentParams, PreparedCliRunContext } from "./types.js";
import "./prepare.js";

type CliRunnerPrepareTestApi = {
  resetCliRunnerPrepareTestDeps(): void;
  setCliRunnerPrepareTestDeps(overrides: Record<string, unknown>): void;
};

function getTestApi(): CliRunnerPrepareTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.cliRunnerPrepareTestApi")
  ] as CliRunnerPrepareTestApi;
}

export function setCliRunnerPrepareTestDeps(overrides: Record<string, unknown>): void {
  getTestApi().setCliRunnerPrepareTestDeps(overrides);
}

export function resetCliRunnerPrepareTestDeps(): void {
  getTestApi().resetCliRunnerPrepareTestDeps();
}

export function createLegacyCliSubagentSessionParams(
  parent: SessionTranscriptRuntimeTarget,
  sessionKey: string,
) {
  const sessionTarget = { ...parent, sessionKey, sessionId: "legacy-cli-child" };
  replaceSessionEntrySync(sessionTarget, {
    sessionId: sessionTarget.sessionId,
    updatedAt: 0,
    spawnedBy: parent.sessionKey,
    completionOwnerSessionKey: parent.sessionKey,
    spawnDepth: 1,
    inheritedToolPolicyVersion: 1,
    inheritedToolAllow: ["*"],
    inheritedToolDeny: [],
  });
  return {
    sessionKey,
    sessionId: sessionTarget.sessionId,
    sessionFile: sessionKey,
    sessionTarget,
    storePath: sessionTarget.storePath,
  };
}

export function registerCliActionPolicyPreflightTests({
  prepare,
  createConfig,
  getSession,
}: {
  prepare: (params: Partial<RunCliAgentParams>) => Promise<PreparedCliRunContext>;
  createConfig: () => OpenClawConfig;
  getSession: () => { dir: string; sessionTarget: SessionTranscriptRuntimeTarget };
}) {
  it.each(["input", "persisted", "persisted-with-manager"] as const)(
    "rejects %s v2 action policy before CLI startup",
    async (source) => {
      const policy = {
        clauses: [{ kind: "configured" as const, allow: ["read"] }],
        parameters: { fileTools: [], exec: [], sandbox: [], unsupported: [] },
      };
      let storedInput: Partial<RunCliAgentParams> = {};
      if (source === "persisted-with-manager") {
        const { dir, sessionTarget: parent } = getSession();
        const sessionTarget = {
          ...parent,
          sessionKey: "agent:main:subagent:cli-policy",
          sessionId: "cli-policy",
        };
        replaceSessionEntrySync(sessionTarget, {
          sessionId: sessionTarget.sessionId,
          updatedAt: 1,
          spawnedBy: parent.sessionKey,
          completionOwnerSessionKey: parent.sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 2,
          inheritedToolPolicy: policy,
        });
        storedInput = {
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
          sessionManager: SessionManager.inMemory(dir),
        };
      }
      const getActiveMcpLoopbackRuntime = vi.fn(() => undefined);
      setCliRunnerPrepareTestDeps({ getActiveMcpLoopbackRuntime });
      await expect(
        prepare({
          config: createConfig(),
          ...(source === "input"
            ? { delegatedInputPolicy: policy }
            : source === "persisted"
              ? {
                  sessionEntry: {
                    sessionId: "cli-policy",
                    updatedAt: 1,
                    inheritedToolPolicyVersion: 2 as const,
                    inheritedToolPolicy: policy,
                  },
                }
              : storedInput),
        }),
      ).rejects.toThrow("cannot enforce the delegated action policy");
      expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
    },
  );

  it("fails closed with upgrade guidance when a backend cannot enforce a runtime toolsAllow", async () => {
    const getActiveMcpLoopbackRuntime = vi.fn(() => ({
      port: 31783,
      ownerToken: "loopback-owner-token",
      nonOwnerToken: "loopback-non-owner-token",
    }));
    setCliRunnerPrepareTestDeps({
      getActiveMcpLoopbackRuntime,
    });

    const run = prepare({
      config: createConfig(),
      toolsAllow: ["read", "web_search"],
    });
    await expect(run).rejects.toThrow(
      `CLI backend "test-cli" cannot enforce this run's tool cap. Upgrade its plugin and retry; if current, ask its maintainer to add exact-cap support. OpenClaw did not start the run.`,
    );

    expect(getActiveMcpLoopbackRuntime).not.toHaveBeenCalled();
  });
}

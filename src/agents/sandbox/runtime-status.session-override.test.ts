import { describe, expect, it } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSandboxContext } from "./context.js";
import {
  resolveSandboxRuntimeStatus,
  resolveSandboxRuntimeStatusesForPersistedSessions,
} from "./runtime-status.js";

describe("session sandbox override", () => {
  it("uses canonical classification identity in exact, batch, and context resolution", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "all" } } } };
      const optional = "agent:main:optional";
      const required = "agent:main:required";
      for (const sessionKey of [optional, required]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            sandboxMode: "off",
            ...(sessionKey === required ? { sandbox: "required" as const } : {}),
          },
        );
      }
      expect(resolveSandboxRuntimeStatus({ cfg, sessionKey: "optional" }).sandboxed).toBe(false);
      expect(
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey: optional,
          classificationSessionKey: required,
        }),
      ).toMatchObject({
        sandboxed: true,
        sandboxRequired: true,
      });
      expect(
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey: required,
          classificationSessionKey: optional,
        }),
      ).toMatchObject({
        sandboxed: false,
        sandboxRequired: false,
      });
      expect(
        resolveSandboxRuntimeStatusesForPersistedSessions([
          { cfg, agentId: "main", env: state.env, sessionKeys: [optional, required] },
        ])[0],
      ).toMatchObject([
        { sandboxed: false, sandboxRequired: false },
        { sandboxed: true, sandboxRequired: true },
      ]);
      // An opted-out session must not start or prepare any sandbox backend.
      await expect(
        resolveSandboxContext({
          config: cfg,
          sessionKey: optional,
          agentId: "main",
          workspaceDir: state.workspaceDir,
        }),
      ).resolves.toBeNull();
    });
  });

  it("classifies a trusted patch candidate without using the old row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { sandbox: { mode: "all", workspaceAccess: "rw" } } },
      };
      const sessionKey = "agent:main:candidate";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        { sessionId: "candidate", updatedAt: 1 },
      );
      expect(resolveSandboxRuntimeStatus({ cfg, sessionKey }).sandboxed).toBe(true);
      expect(
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey,
          preparedSessionEntry: { sandboxMode: "off" },
        }).sandboxed,
      ).toBe(false);
      expect(
        resolveSandboxRuntimeStatus({ cfg, sessionKey, preparedSessionEntry: null }).sandboxed,
      ).toBe(true);
      expect(
        resolveSandboxRuntimeStatus({
          cfg,
          sessionKey,
          preparedSessionEntry: {
            sandbox: "required",
            sandboxMode: "off",
            createdActor: { type: "human", source: "profile", id: "creator" },
          },
        }),
      ).toMatchObject({
        sandboxed: true,
        sandboxRequired: true,
        isolationSubject: { kind: "profile", profileId: "creator" },
        workspaceAccess: "ro",
      });
    });
  });
});

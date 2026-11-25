import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { projectExecutionSessionEntry } from "../../config/sessions/session-entry-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveSandboxRuntimeStatusAsync } from "./runtime-status.js";

it.each([
  { type: "human", source: "profile", id: "causal-requester" },
  { type: "agent", id: "main" },
] as const)(
  "does not move a required sandbox for $type creator attribution",
  async (delegatedBy) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { defaults: { sandbox: { mode: "off" } } } };
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:delegated-isolation";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "delegated-isolation",
          updatedAt: 1,
          sandbox: "required",
          createdActor: {
            type: "human",
            source: "profile",
            id: "isolation-owner",
            delegatedBy,
          },
        },
      );
      const entry = loadSessionEntry({ agentId: "main", sessionKey });
      if (!entry) {
        throw new Error("missing seeded entry");
      }
      expect(
        await resolveSandboxRuntimeStatusAsync({
          cfg,
          sessionKey,
          preparedSessionEntry: projectExecutionSessionEntry(entry),
        }),
      ).toMatchObject({
        sandboxed: true,
        sandboxRequired: true,
        isolationSubject: { kind: "profile", profileId: "isolation-owner" },
      });
    });
  },
);

// Verifies snooze settlement against current session metadata after a run.
import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  createRunResult,
  loadPersistedSessionEntry,
  seedSessionStore,
  updateSessionStoreAfterAgentRun,
  withTempSessionStore,
} from "./session-store.test-support.js";

describe("updateSessionStoreAfterAgentRun snooze", () => {
  it.each([
    {
      name: "completed run",
      inFlight: false,
      touchActivity: true,
      preserve: false,
      snoozed: false,
    },
    {
      name: "snoozed during the run",
      inFlight: true,
      touchActivity: true,
      preserve: false,
      snoozed: false,
    },
    {
      name: "internal-event run",
      inFlight: false,
      touchActivity: false,
      preserve: false,
      snoozed: true,
    },
    {
      name: "preserved-state run",
      inFlight: true,
      touchActivity: true,
      preserve: true,
      snoozed: true,
    },
  ])(
    "settles snooze against the current entry for $name",
    async ({ inFlight, touchActivity, preserve, snoozed }) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:explicit:snooze-completion";
        const sessionId = "snooze-completion";
        const snooze = { snoozedUntil: 4_102_444_800_000, snoozedAt: 1_800_000_000_000 };
        const entry: SessionEntry = {
          sessionId,
          updatedAt: 1,
          lastActivityAt: 1,
          pinnedAt: 1,
          ...(inFlight ? {} : snooze),
        };
        const sessionStore = { [sessionKey]: entry };
        await seedSessionStore(storePath, { [sessionKey]: { ...entry, ...snooze } });

        await updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.4",
          result: createRunResult({ sessionId, provider: "openai", model: "gpt-5.4" }),
          touchInteraction: false,
          touchActivity,
          preserveUserFacingSessionModelState: preserve,
        });

        const persisted = loadPersistedSessionEntry(storePath, sessionKey);
        expect(persisted).toEqual(sessionStore[sessionKey]);
        expect(persisted?.pinnedAt).toBe(1);
        if (snoozed) {
          expect(persisted).toMatchObject({ ...snooze, lastActivityAt: 1 });
        } else {
          expect(persisted).not.toHaveProperty("snoozedUntil");
          expect(persisted).not.toHaveProperty("snoozedAt");
          expect(persisted?.lastActivityAt).toBeGreaterThan(1);
        }
      });
    },
  );
});

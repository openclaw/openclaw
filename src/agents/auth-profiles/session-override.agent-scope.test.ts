import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  authStoreMocks,
  createAuthStoreWithProfiles,
  resolveSessionAuthSelection,
  withAuthState,
} from "./session-override.test-support.js";

it.each(["global", "unknown"])(
  "clears an incompatible %s pin only in the selected agent store",
  async (sessionKey) => {
    await withAuthState(async (state) => {
      const storePath = state.statePath("sessions.json");
      const mainScope = { agentId: "main", sessionKey, storePath };
      const opsScope = { agentId: "ops", sessionKey, storePath };
      await replaceSessionEntry(mainScope, {
        sessionId: "main-session",
        updatedAt: 1,
        authProfileOverride: "anthropic:main",
        authProfileOverrideSource: "user",
      });
      await replaceSessionEntry(opsScope, {
        sessionId: "ops-session",
        updatedAt: 1,
        authProfileOverride: "anthropic:ops",
        authProfileOverrideSource: "user",
        label: "before",
        pinnedAt: 1,
      });
      const sessionEntry = expectDefined(loadSessionEntryReadOnly(opsScope), "ops session");
      const sessionStore = { [sessionKey]: sessionEntry };
      await patchSessionEntryCore(opsScope, () => ({ label: "renamed", pinnedAt: undefined }));
      const mainBefore = loadSessionEntryReadOnly(mainScope);
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "anthropic:ops": { type: "api_key", provider: "anthropic", key: "sk-test" },
        },
      });

      await resolveSessionAuthSelection({
        cfg: {},
        agentId: "ops",
        agentDir: state.agentDir("ops"),
        provider: "openrouter",
        modelId: "model-x",
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
        isNewSession: false,
      });

      expect(loadSessionEntryReadOnly({ ...mainScope, readConsistency: "latest" })).toEqual(
        mainBefore,
      );
      const persisted = loadSessionEntryReadOnly({ ...opsScope, readConsistency: "latest" });
      expect(persisted).toMatchObject({ sessionId: "ops-session", label: "renamed" });
      expect(persisted?.authProfileOverride).toBeUndefined();
      expect(persisted?.authProfileOverrideSource).toBeUndefined();
      expect(persisted?.pinnedAt).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(persisted);
    });
  },
);

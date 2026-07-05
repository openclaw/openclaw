/**
 * Passthrough external-auth mocks for OAuth tests.
 * Keeps tests that exercise local stores isolated from runtime external auth
 * overlays and persistence decisions.
 */
import { vi } from "vitest";

vi.mock("./external-auth.js", () => ({
  listRuntimeExternalAuthProfiles: () => [],
  overlayExternalAuthProfiles: <T>(store: T) => store,
<<<<<<< HEAD
=======
  shouldPersistExternalAuthProfile: () => true,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  syncPersistedExternalCliAuthProfiles: <T>(store: T) => store,
}));

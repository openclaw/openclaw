import { expect, test } from "vitest";
import { MINIMAX_CLI_PROFILE_ID } from "./constants.js";
import { resolveAuthProfileDisplayNameTarget } from "./display-name.js";
import type { RuntimeAuthProfileStore } from "./types.js";

test("does not advertise rename for externally owned or inherited rows", () => {
  const credential = {
    type: "oauth" as const,
    provider: "minimax-portal",
    expires: 2000,
    access: "synthetic-access",
    refresh: "synthetic-refresh",
  };
  const profileId = MINIMAX_CLI_PROFILE_ID;
  const localStore: RuntimeAuthProfileStore = {
    version: 1,
    profiles: { [profileId]: credential },
    runtimeLocalProfileIds: [profileId],
    runtimePersistedProfileIds: [profileId],
  };
  const target = (store: RuntimeAuthProfileStore) =>
    resolveAuthProfileDisplayNameTarget({
      cfg: {},
      store,
      agentDir: "/example/agents/sibling/agent",
      profileId,
      configBound: false,
    });
  expect(target(localStore)).toBe("local");
  expect(target({ ...localStore, runtimeExternalProfileIds: [profileId] })).toBe("external");
  expect(target({ ...localStore, runtimeLocalProfileIds: [] })).toBeUndefined();
  expect(
    target({
      ...localStore,
      profiles: { [profileId]: { ...credential, authFlow: "external-cli" } },
    }),
  ).toBe("external");
});

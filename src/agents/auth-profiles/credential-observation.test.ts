import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { cloneAuthProfileStore } from "./clone.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import {
  observeCachedCanonicalAuthProfileCredentials as replay,
  observeCanonicalAuthProfileCredentials as publish,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation as Observation,
} from "./credential-observation.js";
import { overlayRuntimeExternalOAuthProfiles } from "./oauth-shared.js";
import type { ApiKeyCredential, AuthProfileStore } from "./types.js";

const apiKey = (key: string) => ({ type: "api_key" as const, provider: "fixture", key });
const observe = (values: Observation[], run: () => Promise<void>) =>
  withCanonicalAuthProfileCredentialObserver((value) => values.push(value), run);

it("isolates requests and retains nested observations until close", async () => {
  const first: Observation[] = [],
    second: Observation[] = [],
    inner: Observation[] = [];
  const [ready, release] = [createDeferredCore(), createDeferredCore()];
  const profiles = { selected: apiKey("key") };
  await Promise.all([
    observe(first, async () => {
      ready.resolve();
      await release.promise;
      await observe(inner, async () => {
        publish("/first.sqlite", profiles);
      });
    }),
    observe(second, async () => {
      await ready.promise;
      publish("/second.sqlite", profiles);
      release.resolve();
    }),
  ]);
  expect(first.map(({ databasePath }) => databasePath)).toEqual(["/first.sqlite"]);
  expect(second.map(({ databasePath }) => databasePath)).toEqual(["/second.sqlite"]);
  expect(inner).toEqual(first);
});

it("does not deliver late settlement from a failed inner scope to an active parent", async () => {
  const observations: Observation[] = [];
  const release = createDeferredCore();
  let late: Promise<void> | undefined;
  await observe(observations, async () => {
    await expect(
      observe(observations, async () => {
        late = release.promise.then(() => {
          publish("/late.sqlite", { selected: apiKey("late") });
        });
        throw new Error("discovery failed");
      }),
    ).rejects.toThrow("discovery failed");
    release.resolve();
    await late;
  });
  expect(observations).toEqual([]);
});

it("copies exact provenance without trusting changed or unmarked rows", async () => {
  const selected = {
    ...apiKey("canonical"),
    keyRef: { source: "env", provider: "default", id: "FIXTURE_KEY" },
  } satisfies ApiKeyCredential;
  const store = { version: 1, profiles: { selected } };
  publish("/canonical.sqlite", store.profiles);
  const cloned: AuthProfileStore = cloneAuthProfileStore(cloneAuthProfileStore(store));
  const observations: Observation[] = [];
  await observe(observations, async () => {
    replay(cloned.profiles);
    cloned.profiles.selected = apiKey("canonical");
    replay(cloned.profiles);
    const changed = cloneAuthProfileStore(store);
    changed.profiles.selected.key = "runtime-only";
    replay(cloneAuthProfileStore(changed).profiles);
    const nested = cloneAuthProfileStore(store);
    nested.profiles.selected.keyRef.id = "DIFFERENT_KEY";
    replay(cloneAuthProfileStore(nested).profiles);
  });
  expect(observations).toEqual([{ databasePath: "/canonical.sqlite", profiles: store.profiles }]);
});

it("does not attribute an external OAuth overlay to the canonical row it replaced", async () => {
  const credential = createOAuthRefreshCredential({
    provider: "fixture",
    expires: 4_102_444_800_000,
  });
  const store: AuthProfileStore = { version: 1, profiles: { selected: credential } };
  publish("/canonical.sqlite", store.profiles);
  const external = overlayRuntimeExternalOAuthProfiles(store, [
    { profileId: "selected", credential: { ...credential, access: "external-only" } },
  ]);
  const observations: Observation[] = [];
  await observe(observations, async () => {
    replay(cloneAuthProfileStore(external).profiles);
  });
  expect(observations).toEqual([]);
});

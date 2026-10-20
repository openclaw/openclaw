import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { cloneAuthProfileStore } from "./clone.js";
import { createOAuthRefreshCredential } from "./credential-fixtures.test-support.js";
import {
  observeCachedCanonicalAuthProfileCredentials,
  observeCanonicalAuthProfileCredentials,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import { overlayRuntimeExternalOAuthProfiles } from "./oauth-shared.js";
import type { AuthProfileStore } from "./types.js";

type Observations = CanonicalAuthProfileCredentialObservation[];
const apiKey = (key: string) => ({ type: "api_key" as const, provider: "fixture", key });
const observe = (values: Observations, run: () => Promise<void>) =>
  withCanonicalAuthProfileCredentialObserver((value) => values.push(value), run);

describe("canonical auth credential observation", () => {
  it("isolates requests and retains nested observations until close", async () => {
    const first: Observations = [],
      second: Observations = [],
      inner: Observations = [];
    const ready = createDeferredCore();
    const release = createDeferredCore();
    const profiles = { selected: apiKey("key") };
    await Promise.all([
      observe(first, async () => {
        ready.resolve();
        await release.promise;
        await observe(inner, async () => {
          observeCanonicalAuthProfileCredentials("/first.sqlite", profiles);
        });
      }),
      observe(second, async () => {
        await ready.promise;
        observeCanonicalAuthProfileCredentials("/second.sqlite", profiles);
        release.resolve();
      }),
    ]);
    expect(first.map(({ databasePath }) => databasePath)).toEqual(["/first.sqlite"]);
    expect(second.map(({ databasePath }) => databasePath)).toEqual(["/second.sqlite"]);
    expect(inner).toEqual(first);
  });

  it("does not deliver late settlement from a failed inner scope to an active parent", async () => {
    const observations: Observations = [];
    const release = createDeferredCore();
    let late: Promise<void> | undefined;
    await observe(observations, async () => {
      await expect(
        observe(observations, async () => {
          late = release.promise.then(() => {
            observeCanonicalAuthProfileCredentials("/late.sqlite", {
              selected: apiKey("late"),
            });
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
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        selected: {
          ...apiKey("canonical"),
          keyRef: { source: "env", provider: "default", id: "FIXTURE_KEY" },
        },
      },
    };
    observeCanonicalAuthProfileCredentials("/canonical.sqlite", store.profiles);
    const cloned = cloneAuthProfileStore(cloneAuthProfileStore(store));
    const observations: Observations = [];
    await observe(observations, async () => {
      observeCachedCanonicalAuthProfileCredentials(cloned.profiles);
      cloned.profiles.selected = apiKey("canonical");
      observeCachedCanonicalAuthProfileCredentials(cloned.profiles);
      const changed = cloneAuthProfileStore(store);
      Object.assign(changed.profiles.selected!, { key: "runtime-only" });
      observeCachedCanonicalAuthProfileCredentials(cloneAuthProfileStore(changed).profiles);
      const nested = cloneAuthProfileStore(store);
      const credential = nested.profiles.selected;
      if (credential?.type !== "api_key" || !credential.keyRef) {
        throw new Error("Expected canonical SecretRef fixture");
      }
      credential.keyRef.id = "DIFFERENT_KEY";
      observeCachedCanonicalAuthProfileCredentials(cloneAuthProfileStore(nested).profiles);
    });
    expect(observations).toEqual([{ databasePath: "/canonical.sqlite", profiles: store.profiles }]);
  });

  it("does not attribute an external OAuth overlay to the canonical row it replaced", async () => {
    const credential = createOAuthRefreshCredential({
      provider: "fixture",
      access: "canonical-access",
      refresh: "canonical-refresh",
      expires: 4_102_444_800_000,
    });
    const store: AuthProfileStore = { version: 1, profiles: { selected: credential } };
    observeCanonicalAuthProfileCredentials("/canonical.sqlite", store.profiles);
    const external = overlayRuntimeExternalOAuthProfiles(store, [
      { profileId: "selected", credential: { ...credential, access: "external-only" } },
    ]);
    const observations: Observations = [];
    await observe(observations, async () => {
      observeCachedCanonicalAuthProfileCredentials(cloneAuthProfileStore(external).profiles);
    });
    expect(observations).toEqual([]);
  });
});

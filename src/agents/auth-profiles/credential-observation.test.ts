import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { cloneAuthProfileStore } from "./clone.js";
import {
  observeCachedCanonicalAuthProfileCredentials,
  observeCanonicalAuthProfileCredentials,
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import { overlayRuntimeExternalOAuthProfiles } from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

describe("canonical auth credential observation", () => {
  it("isolates requests and retains nested observations until close", async () => {
    const first: CanonicalAuthProfileCredentialObservation[] = [];
    const second: CanonicalAuthProfileCredentialObservation[] = [];
    const inner: CanonicalAuthProfileCredentialObservation[] = [];
    const ready = createDeferredCore();
    const release = createDeferredCore();
    const profiles = { selected: { type: "api_key" as const, provider: "fixture", key: "key" } };
    await Promise.all([
      withCanonicalAuthProfileCredentialObserver(
        (value) => first.push(value),
        async () => {
          ready.resolve();
          await release.promise;
          await withCanonicalAuthProfileCredentialObserver(
            (value) => inner.push(value),
            async () => {
              observeCanonicalAuthProfileCredentials("/first.sqlite", profiles);
            },
          );
        },
      ),
      withCanonicalAuthProfileCredentialObserver(
        (value) => second.push(value),
        async () => {
          await ready.promise;
          observeCanonicalAuthProfileCredentials("/second.sqlite", profiles);
          release.resolve();
        },
      ),
    ]);
    expect(first.map(({ databasePath }) => databasePath)).toEqual(["/first.sqlite"]);
    expect(second.map(({ databasePath }) => databasePath)).toEqual(["/second.sqlite"]);
    expect(inner).toEqual(first);
  });

  it("does not deliver late settlement from a failed inner scope to an active parent", async () => {
    const observations: CanonicalAuthProfileCredentialObservation[] = [];
    const release = createDeferredCore();
    let late: Promise<void> | undefined;
    await withCanonicalAuthProfileCredentialObserver(
      (value) => observations.push(value),
      async () => {
        await expect(
          withCanonicalAuthProfileCredentialObserver(
            (value) => observations.push(value),
            async () => {
              late = release.promise.then(() => {
                observeCanonicalAuthProfileCredentials("/late.sqlite", {
                  selected: { type: "api_key", provider: "fixture", key: "late" },
                });
              });
              throw new Error("discovery failed");
            },
          ),
        ).rejects.toThrow("discovery failed");
        release.resolve();
        await late;
      },
    );
    expect(observations).toEqual([]);
  });

  it("copies exact provenance without trusting changed or unmarked rows", async () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        selected: { type: "api_key", provider: "fixture", key: "canonical" },
      },
    };
    observeCanonicalAuthProfileCredentials("/canonical.sqlite", store.profiles);
    const cloned = cloneAuthProfileStore(cloneAuthProfileStore(store));
    const observations: CanonicalAuthProfileCredentialObservation[] = [];
    await withCanonicalAuthProfileCredentialObserver(
      (value) => observations.push(value),
      async () => {
        observeCachedCanonicalAuthProfileCredentials(cloned.profiles);
        cloned.profiles.selected = { type: "api_key", provider: "fixture", key: "canonical" };
        observeCachedCanonicalAuthProfileCredentials(cloned.profiles);
        const changed = cloneAuthProfileStore(store);
        Object.assign(changed.profiles.selected!, { key: "runtime-only" });
        observeCachedCanonicalAuthProfileCredentials(cloneAuthProfileStore(changed).profiles);
      },
    );
    expect(observations).toEqual([{ databasePath: "/canonical.sqlite", profiles: store.profiles }]);
  });

  it("does not attribute an external OAuth overlay to the canonical row it replaced", async () => {
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "fixture",
      access: "canonical-access",
      refresh: "canonical-refresh",
      expires: 4_102_444_800_000,
    };
    const store: AuthProfileStore = { version: 1, profiles: { selected: credential } };
    observeCanonicalAuthProfileCredentials("/canonical.sqlite", store.profiles);
    const external = overlayRuntimeExternalOAuthProfiles(store, [
      { profileId: "selected", credential: { ...credential, access: "external-only" } },
    ]);
    const observations: CanonicalAuthProfileCredentialObservation[] = [];
    await withCanonicalAuthProfileCredentialObserver(
      (value) => observations.push(value),
      async () => {
        observeCachedCanonicalAuthProfileCredentials(cloneAuthProfileStore(external).profiles);
      },
    );
    expect(observations).toEqual([]);
  });
});

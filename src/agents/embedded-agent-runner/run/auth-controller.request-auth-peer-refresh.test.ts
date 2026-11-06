import "../../auth-profiles/external-auth.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import { getProviderRequestAuth } from "../../../plugins/provider-auth-authority.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as modelAuth from "../../model-auth.js";
import { profileId, withRequestFixture } from "./auth-controller.request-auth.test-support.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Fixture = Parameters<Parameters<typeof withRequestFixture>[0]>[0];
type Outcome = { auth: { apiKey: string; assertCurrent(): void } } | { error: unknown };

const refreshed = (fixture: Fixture) => async () => ({
  ...fixture.credential,
  access: "synthetic-access-after",
  refresh: "synthetic-refresh-after",
  expires: Date.now() + 3_600_000,
});

// A peer run sharing this account claims the refresh and holds its durable pending fence until
// `release`; `settle` is the refresh result the peer then publishes.
async function holdPeerRefresh(
  fixture: Fixture,
  settle: () => ReturnType<Fixture["refresh"]>,
  release = createDeferredCore(),
  beforeEnter?: Promise<void>,
) {
  const entered = createDeferredCore();
  fixture.refresh.mockImplementationOnce(async () => {
    await beforeEnter;
    entered.resolve();
    await release.promise;
    return settle();
  });
  vi.setSystemTime(fixture.credential.expires + 1);
  const peer = modelAuth
    .getApiKeyForModelCore({
      model: fixture.authState.models.effective,
      cfg: { plugins: { enabled: false } },
      profileId,
      lockedProfile: true,
      allowAuthProfileFallback: false,
      agentDir: fixture.agentDir,
    })
    .catch((error: unknown) => ({ error }));
  await entered.promise;
  return { peer, release: () => release.resolve() };
}

// Callers initialize the controller first; a second initialization would queue on the peer's lock.
function requestAuth(fixture: Fixture): { outcome: Promise<Outcome> } {
  const capability = getProviderRequestAuth(fixture.authState.models.effective);
  if (!capability) {
    throw new Error("Missing request auth");
  }
  return {
    outcome: capability.resolve({}).then(
      (auth) => ({ auth }),
      (error: unknown) => ({ error }),
    ),
  };
}

// Let the request observe the pending fence before the test moves on.
const observeFence = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });

it("waits for a peer run's in-flight OAuth refresh instead of failing the request as unavailable", async () => {
  await withRequestFixture(async (fixture) => {
    await fixture.controller.initializeAuthProfile();
    const { peer, release } = await holdPeerRefresh(fixture, refreshed(fixture));
    const { outcome } = requestAuth(fixture);
    await observeFence();
    release();
    await expect(peer).resolves.toMatchObject({ apiKey: "synthetic-access-after" });
    await expect(outcome).resolves.toMatchObject({ auth: { apiKey: "synthetic-access-after" } });
    expect(fixture.refresh).toHaveBeenCalledOnce();
  });
});

it("does not mask a peer refresh that fails while this request waits on it", async () => {
  await withRequestFixture(async (fixture) => {
    await fixture.controller.initializeAuthProfile();
    const { peer, release } = await holdPeerRefresh(fixture, async () => {
      throw new Error("synthetic refresh outage");
    });
    const { outcome } = requestAuth(fixture);
    await observeFence();
    release();
    await peer;
    // The failed claim stays a terminal fence; the waiting request ends instead of polling on.
    await expect(outcome).resolves.toMatchObject({ error: { code: "MCP_AUTHORIZATION_RETIRED" } });
  });
});

it("rejects a waiting request at closure before the peer refresh settles", async () => {
  await withRequestFixture(async (fixture) => {
    await fixture.controller.initializeAuthProfile();
    const { peer, release } = await holdPeerRefresh(fixture, refreshed(fixture));
    const { outcome } = requestAuth(fixture);
    await observeFence();
    fixture.controller.stopRuntimeAuthRefreshTimer();
    await expect(outcome).resolves.toMatchObject({
      error: { message: expect.stringMatching(/closed/) },
    });
    release();
    await peer;
  });
});

it("resolves again instead of returning the token read before a peer publication", async () => {
  await withRequestFixture(async (fixture) => {
    await fixture.controller.initializeAuthProfile();
    let held: Awaited<ReturnType<typeof holdPeerRefresh>> | undefined;
    const lookup = modelAuth.getApiKeyForModelCore;
    const spy = vi.spyOn(modelAuth, "getApiKeyForModelCore");
    spy.mockImplementationOnce(async (params) => {
      const resolved = await lookup(params);
      held = await holdPeerRefresh(fixture, refreshed(fixture));
      setTimeout(() => held?.release(), 50);
      return resolved;
    });
    const result = await requestAuth(fixture).outcome;
    await held?.peer;
    expect(result).toMatchObject({ auth: { apiKey: "synthetic-access-after" } });
    // Two request lookups around the peer's publication, plus the peer's own lookup.
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

it.each([false, true])(
  "bounds peer refresh at the run deadline (preparing=%s)",
  async (preparing) => {
    // Date is frozen by the fixture, so every auth step gets the same one-second real budget.
    const getDeadline = () => ({ kind: "bounded" as const, deadlineAtMs: Date.now() + 1_000 });
    await withRequestFixture(
      async (fixture) => {
        await fixture.controller.initializeAuthProfile();
        let held: Awaited<ReturnType<typeof holdPeerRefresh>> | undefined;
        const peerAdmission = createDeferredCore();
        const release = createDeferredCore();
        const lookup = modelAuth.getApiKeyForModelCore;
        vi.spyOn(modelAuth, "getApiKeyForModelCore").mockImplementationOnce(async (params) => {
          const resolved = await lookup(params);
          held = await holdPeerRefresh(
            fixture,
            refreshed(fixture),
            release,
            preparing ? peerAdmission.promise : undefined,
          );
          return resolved;
        });
        const { outcome } = requestAuth(fixture);
        try {
          const settledBeforePeer = await Promise.race([
            outcome,
            new Promise((resolve) => {
              setTimeout(() => resolve("still waiting"), 5_000);
            }),
          ]);
          expect(settledBeforePeer).toMatchObject({
            error: { message: expect.stringMatching(/timed out at the run deadline/) },
          });
        } finally {
          peerAdmission.resolve();
          // The auth deadline can settle before holdPeerRefresh returns its cleanup handle.
          release.resolve();
          await held?.peer;
        }
      },
      { getDeadline },
    );
  },
);

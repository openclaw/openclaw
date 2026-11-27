import { createHash } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  dispatchGatewayMethod,
  sendToResolvedSession,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  createPluginStateKeyedStoreV2ForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import {
  BEAM_MAX_SENDS_PER_PUBLICATION,
  BEAM_SEND_PENDING_MS,
} from "../continuation-operation-api.js";
import { createBeamContinuation } from "./continuation-v2.js";
import {
  BEAM_MAX_GUEST_RECEIPTS,
  BEAM_MAX_WRITE_RECEIPTS,
  BEAM_RETENTION_MS,
  type BeamHandoff,
} from "./types.js";

const owner: GatewayRequestAuthorityV1 = {
  personProfileId: "alice",
  requiredGrantPluginId: "visitor-access",
  scopes: ["operator.sessions.write"],
  assertCurrent() {},
  async revalidate() {},
};
const staff: GatewayRequestAuthorityV1 = {
  personProfileId: "bob",
  scopes: ["operator.write"],
  assertCurrent() {},
  async revalidate() {},
};
const request = {
  requestId: "12345678-1234-4234-9234-000000000001",
  instruction: "a new instruction",
  agent: "main",
};
const binding = {
  id: "binding",
  agentId: "main",
  sessionKey: "agent:main:dashboard:binding",
  ready: true as const,
};
const source: BeamHandoff = {
  version: 1,
  beamId: "a".repeat(32),
  publicationId: "b".repeat(32),
  handoffId: "b".repeat(32),
  publisherProfileId: "alice",
  source: "fixture",
  title: "Fixture",
  updatedAt: "2026-01-01T00:00:00Z",
  completed: true,
  createdAt: 1,
  receivedAt: 1,
};
const hash = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

async function fixture() {
  resetPluginStateStoreForTests();
  const state = await createOpenClawTestState({ label: "beam-continue" });
  const make = <T>(namespace: string, retained: boolean) =>
    createPluginStateKeyedStoreV2ForTests<T>(
      "beam",
      retained
        ? { namespace, retention: "retained", env: state.env }
        : {
            namespace,
            maxEntries: BEAM_MAX_WRITE_RECEIPTS,
            overflowPolicy: "reject-new",
            defaultTtlMs: BEAM_RETENTION_MS,
            env: state.env,
          },
      { assertCurrent() {} },
    );
  const handoffs = make<BeamHandoff>("handoffs", true);
  const identities = make<unknown>("continuation-identities", true);
  const receipts = make<unknown>("continuation-requests", false);
  const runtime = {
    state: {
      openKeyedStoreV2: ({ namespace }: { namespace: string }) =>
        namespace === "handoffs"
          ? handoffs
          : namespace === "continuation-identities"
            ? identities
            : receipts,
    },
  } as unknown as PluginRuntime;
  let row = { ...source };
  await handoffs.register(row.beamId, row);
  let nativeId = "first-session";
  let resolveFailure: "FORBIDDEN" | "UNAVAILABLE" | undefined;
  let onResolve: (() => void) | undefined;
  let replaceBeforeSend = false;
  let lostAck = false;
  let waitOnSend:
    | {
        entered: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  let sends = 0;
  let adopted = 0;
  const attempts: Parameters<typeof sendToResolvedSession>[0][] = [];
  const dispatch: typeof dispatchGatewayMethod = async (method) => {
    if (method.endsWith(".resolve")) {
      onResolve?.();
      if (resolveFailure) {
        return { ok: false, error: { code: resolveFailure, message: "failed" } };
      }
      return { ok: true, payload: { sessionKey: binding.sessionKey, sessionId: nativeId } };
    }
    if (method.endsWith(".continue")) {
      adopted++;
      row = { ...row, continuation: binding };
      await handoffs.register(row.beamId, row);
      return { ok: true, payload: { sessionKey: binding.sessionKey } };
    }
    throw new Error("unexpected host method");
  };
  const send: typeof sendToResolvedSession = async (input) => {
    attempts.push(input);
    if (replaceBeforeSend) {
      nativeId = "replacement";
    }
    if (input.target.sessionId !== nativeId) {
      return "unconfirmed";
    }
    sends++;
    if (waitOnSend) {
      waitOnSend.entered.resolve();
      await waitOnSend.release.promise;
    }
    if (lostAck) {
      throw new Error("ack lost");
    }
    return "accepted";
  };
  const service = () =>
    createBeamContinuation(
      runtime,
      { readPublication: async () => ({ snapshot: { ...row, items: [] }, ownership: row }) },
      dispatch,
      send,
    );
  return {
    service,
    attempts,
    receipts,
    identities,
    get sends() {
      return sends;
    },
    get adopted() {
      return adopted;
    },
    deny() {
      resolveFailure = "FORBIDDEN";
    },
    onResolve(callback: () => void) {
      onResolve = callback;
    },
    removeDestination() {
      resolveFailure = "UNAVAILABLE";
    },
    replace() {
      replaceBeforeSend = true;
    },
    replaceReadableDestination() {
      nativeId = "readable-replacement";
    },
    hold() {
      waitOnSend = { entered: createDeferred<void>(), release: createDeferred<void>() };
      return waitOnSend;
    },
    loseAck() {
      lostAck = true;
    },
    async [Symbol.asyncDispose]() {
      await closeOpenClawStateDatabaseAsync();
      resetPluginStateStoreForTests();
      await state.cleanup();
    },
  };
}

it("adopts once and sends once under a durable identity, even across services and concurrent retries", async () => {
  await using f = await fixture();
  const gate = f.hold();
  const first = f.service().continue(source, request, owner);
  await gate.entered.promise;
  try {
    expect(await f.service().continue(source, request, owner)).toMatchObject({ state: "pending" });
    expect(await f.service().status(source, request.requestId, owner)).toMatchObject({
      state: "pending",
    });
  } finally {
    gate.release.resolve();
  }
  expect(await first).toMatchObject({
    state: "accepted",
    destination: { reference: binding.id },
  });
  const [replay, other] = await Promise.all([
    f.service().continue(source, request, owner),
    f.service().status(source, request.requestId, owner),
  ]);
  expect(replay).toEqual(other);
  expect(f.adopted).toBe(1);
  expect(f.sends).toBe(1);
  expect(f.attempts[0]?.message).toBe(request.instruction);
  expect(f.attempts[0]?.idempotencyKey).not.toBe(request.requestId);
  expect(await f.service().continue(source, { ...request, instruction: "changed" }, owner)).toBe(
    "request_identity_conflict",
  );
  expect(await f.service().continue(source, request, staff)).toBe("unavailable");
  expect(await f.service().continue(source, { ...request, instruction: "changed" }, staff)).toBe(
    "unavailable",
  );
  expect(await f.service().continue(source, { ...request, agent: "changed" }, staff)).toBe(
    "unavailable",
  );
  expect(await f.service().status(source, request.requestId, staff)).toBe("unavailable");
  expect(await f.service().status(source, "never-submitted", staff)).toBe("unavailable");
  const reader = { ...staff, personProfileId: owner.personProfileId, scopes: ["operator.read"] };
  expect(await f.service().status(source, request.requestId, reader)).toEqual(replay);
  expect(await f.service().continue(source, request, reader)).toBe("unavailable");
  expect(await f.service().continue(source, { ...request, agent: "changed" }, owner)).toBe(
    "request_identity_conflict",
  );
  f.deny();
  expect(await f.service().status(source, request.requestId, owner)).toBe("unavailable");
  expect(await f.service().status(source, request.requestId, reader)).toBe("unavailable");
  expect(await f.service().continue(source, request, owner)).toBe("unavailable");
  expect(f.sends).toBe(1);
});

it("keeps request lookups private after the destination disappears", async () => {
  await using f = await fixture();
  expect(await f.service().status(source, request.requestId, owner)).toBe("unavailable");
  expect(f.adopted).toBe(0);
  expect(await f.service().continue(source, request, owner)).toMatchObject({ state: "accepted" });
  f.removeDestination();
  expect(await f.service().status(source, request.requestId, owner)).toEqual({
    requestId: request.requestId,
    state: "needs_reconciliation",
  });
  expect(await f.service().status(source, "never-submitted", owner)).toBe("unavailable");
  expect(await f.service().status(source, request.requestId, staff)).toBe("unavailable");
  expect(await f.service().continue(source, request, staff)).toBe("unavailable");
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  expect(f.adopted).toBe(1);
  expect(f.sends).toBe(1);
});

it("checks the admitted request lifetime for status", async () => {
  await using f = await fixture();
  let connected = true;
  const checked: (string | undefined)[] = [];
  let guestRefreshes = 0;
  function guard(requiredGrant?: string) {
    checked.push(requiredGrant);
    if (!connected) {
      throw new Error("request closed");
    }
  }
  const guest: GatewayRequestAuthorityV1 = {
    ...owner,
    assertCurrent: guard,
    async revalidate(requiredGrant) {
      if (requiredGrant === "visitor-access") {
        guestRefreshes++;
      }
      guard(requiredGrant);
    },
  };
  const gate = f.hold();
  const inFlight = f.service().continue(source, request, guest);
  await gate.entered.promise;
  gate.release.resolve();
  await expect(inFlight).resolves.toMatchObject({ state: "accepted" });
  guest.assertCurrent("visitor-access"); // The HTTP route admits this GET before calling the service.
  const beforeRead = checked.length;
  const refreshesBeforeRead = guestRefreshes;
  expect(await f.service().status(source, request.requestId, guest)).toMatchObject({
    requestId: request.requestId,
  });
  expect(checked.slice(beforeRead)).not.toContain("visitor-access");
  expect(guestRefreshes).toBe(refreshesBeforeRead);
  const withoutGrant = { ...guest, requiredGrantPluginId: undefined };
  expect(await f.service().status(source, request.requestId, withoutGrant)).toBe("unavailable");
  f.onResolve(() => {
    connected = false;
  });
  await expect(f.service().status(source, request.requestId, guest)).rejects.toThrow(
    "request closed",
  );
  expect(f.sends).toBe(1);
});

it("fences the original native session when it changes between authorized resolution and send", async () => {
  await using f = await fixture();
  f.replace();
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  expect(f.attempts.map((p) => p.target)).toEqual([
    { sessionKey: binding.sessionKey, sessionId: "first-session" },
  ]);
  expect(f.sends).toBe(0);
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  expect(f.attempts).toHaveLength(1);
  expect(f.adopted).toBe(1);
});

it("reports the original acknowledgement without identifying a replacement as its recipient", async () => {
  await using f = await fixture();
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "accepted",
    destination: { reference: binding.id },
  });
  f.replaceReadableDestination();
  const historical = { state: "accepted", requestId: request.requestId };
  expect(await f.service().status(source, request.requestId, owner)).toEqual(historical);
  expect(await f.service().continue(source, request, owner)).toEqual(historical);
  expect(await f.service().status(source, request.requestId, staff)).toBe("unavailable");
  expect(f.attempts).toHaveLength(1);
  expect(f.sends).toBe(1);
});

it("never replays a potentially accepted turn after loss, process interruption, or expiry", async () => {
  await using f = await fixture();
  f.loseAck();
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  const key = hash("continue", source.beamId, source.publicationId!, request.requestId);
  await f.receipts.register(key, {
    state: "pending",
    claim: "interrupted",
    startedAt: Date.now() - BEAM_SEND_PENDING_MS - 1,
  });
  expect(await f.service().status(source, request.requestId, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  await f.receipts.delete(key);
  expect(await f.service().continue(source, request, owner)).toMatchObject({
    state: "needs_reconciliation",
  });
  expect(f.sends).toBe(1);
});

it("admits a fresh request only while its guest and publication budgets allow it", async () => {
  await using f = await fixture();
  const key = "guest:" + hash("person", "alice");
  await f.receipts.register(
    key,
    Array(BEAM_MAX_GUEST_RECEIPTS).fill(Date.now() + BEAM_RETENTION_MS),
  );
  expect(await f.service().continue(source, request, owner)).toBe("rate_limited");
  expect(await f.service().continue(source, request, staff)).toMatchObject({ state: "accepted" });
  await f.identities.register(
    "count:" + source.beamId + "." + source.publicationId,
    BEAM_MAX_SENDS_PER_PUBLICATION,
  );
  expect(
    await f
      .service()
      .continue(source, { ...request, requestId: "12345678-1234-4234-9234-000000000002" }, staff),
  ).toBe("publication_send_limit");
  expect(await f.service().continue(source, request, staff)).toMatchObject({ state: "accepted" });
  expect(f.sends).toBe(1);
});

import type { GatewayRequestAuthorityV1 } from "openclaw/plugin-sdk/gateway-request-authority";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamOwnedViewHandler } from "./owned-view.js";

function visitorAuthority(assertCurrent: () => void): GatewayRequestAuthorityV1 {
  return {
    scopes: ["operator.sessions.write"],
    personProfileId: "alice",
    requiredGrantPluginId: "visitor-access",
    assertCurrent(requiredGrant) {
      expect(requiredGrant).toBe("visitor-access");
      assertCurrent();
    },
    async revalidate(requiredGrant) {
      expect(requiredGrant).toBe("visitor-access");
      assertCurrent();
    },
  };
}

it.each(["revoked", "expired", "transport", "role"])(
  "withholds an owned transcript when authority ends during storage IO: %s",
  async (cause) => {
    const stored = {
      ...sampleUpload(),
      publisherProfileId: "alice",
      uploaderProfileId: "staff-private-profile",
      createdAt: 1,
      receivedAt: 1,
    };
    const read = Promise.withResolvers<typeof stored>();
    const entered = Promise.withResolvers<void>();
    const grant = new AbortController();
    let connected = true;
    let now = 0;
    let roleCurrent = true;
    const authority = visitorAuthority(() => {
      if (!connected || !roleCurrent) {
        throw new Error("publisher authority ended");
      }
      grant.signal.throwIfAborted();
      if (now >= 1) {
        throw new Error("Visitor invitation expired");
      }
    });
    const store = {
      ...memoryStore(),
      async get() {
        entered.resolve();
        return read.promise;
      },
    };
    const respond = vi.fn();
    const pending = createBeamOwnedViewHandler(
      store,
      "read",
      () => authority,
    )({
      params: { hostId: "gateway", threadId: stored.beamId },
      respond,
      sessionMutationAuthorization: {
        assertTargetCurrent() {},
        assertCurrent() {
          if (!roleCurrent) {
            throw new Error("named role revoked");
          }
        },
      },
    });
    await entered.promise;
    if (cause === "transport") {
      connected = false;
    } else if (cause === "role") {
      roleCurrent = false;
    } else if (cause === "expired") {
      now = 1;
    } else {
      grant.abort(new Error(cause));
    }
    read.resolve(stored);
    await pending;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
    expect(JSON.stringify(respond.mock.calls)).not.toContain("Please fix");
    expect(JSON.stringify(respond.mock.calls)).not.toContain("staff-private-profile");
  },
);

it("reports stale pages and unavailable storage without asking a current publisher to sign in", async () => {
  const store = memoryStore();
  const stored = { ...sampleUpload(), publisherProfileId: "alice", createdAt: 1, receivedAt: 1 };
  store.values.set(stored.beamId, stored);
  const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
  const authority = visitorAuthority(() => {});
  const baseParams = { hostId: "gateway", threadId: stored.beamId, limit: 1 };
  const invoke = async (params: Record<string, unknown>, source = store) => {
    respond.mockClear();
    await createBeamOwnedViewHandler(
      source,
      "read",
      () => authority,
    )({
      params,
      respond,
      sessionMutationAuthorization: { assertCurrent() {}, assertTargetCurrent() {} },
    });
    return respond.mock.calls[0];
  };
  const first = await invoke(baseParams);
  expect(first?.[0]).toBe(true);
  const page = first?.[1];
  if (!isRecord(page) || typeof page.nextCursor !== "string") {
    throw new Error("Expected a paged owned transcript");
  }
  store.values.set(stored.beamId, {
    ...stored,
    items: [...stored.items, { type: "other", text: "Refreshed snapshot" }],
  });
  const stale = await invoke({ ...baseParams, cursor: page.nextCursor });
  expect(stale?.[0]).toBe(false);
  expect(stale?.[2]).toMatchObject({
    code: "INVALID_REQUEST",
    message: expect.stringContaining("Reload"),
  });
  const unavailable = await invoke(baseParams, {
    ...store,
    get: async () => {
      throw new Error("Private database detail");
    },
  });
  expect(unavailable?.[0]).toBe(false);
  expect(unavailable?.[2]).toMatchObject({
    code: "UNAVAILABLE",
    message: expect.stringContaining("try again"),
  });
  expect(JSON.stringify(respond.mock.calls)).not.toContain("Private database detail");
});

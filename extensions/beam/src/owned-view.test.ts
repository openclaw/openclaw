import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { expect, it, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamOwnedViewHandler } from "./owned-view.js";

// Only the authenticated fields consumed by the handler are supplied by this fixture.
function visitorClient(assertCurrent: () => void) {
  return {
    connect: { scopes: ["operator.sessions.write"] },
    authenticatedUserProfile: { profileId: "alice" },
    internal: {
      operatorAccessAuthority: {
        requiredPolicyPlugin: "visitor-access",
        gatewayAccessGrant: { pluginId: "visitor-access" },
        assertCurrent,
      },
    },
  } as NonNullable<GatewayRequestHandlerOptions["client"]>;
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
    const client = visitorClient(() => {
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
    )({
      params: { hostId: "gateway", threadId: stored.beamId },
      client,
      respond,
      hasCurrentClientAuthority: () => connected,
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
  const client = visitorClient(() => {});
  const baseParams = { hostId: "gateway", threadId: stored.beamId, limit: 1 };
  const invoke = async (params: Record<string, unknown>, source = store) => {
    respond.mockClear();
    await createBeamOwnedViewHandler(
      source,
      "read",
    )({
      params,
      client,
      respond,
      hasCurrentClientAuthority: () => true,
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

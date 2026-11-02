import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { expect, it, vi } from "vitest";
import { memoryStore, sampleUpload } from "./beam-store.test-support.js";
import { createBeamOwnedViewHandler } from "./owned-view.js";

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
    // Only the transport-owned fields consumed by this handler are supplied by the fixture.
    const client = {
      connect: { scopes: ["operator.sessions.write"] },
      authenticatedUserProfile: { profileId: "alice" },
      internal: {
        operatorAccessAuthority: {
          requiredPolicyPlugin: "visitor-access",
          gatewayAccessGrant: { pluginId: "visitor-access" },
          assertCurrent() {
            grant.signal.throwIfAborted();
            if (now >= 1) throw new Error("Visitor invitation expired");
          },
        },
      },
    } as NonNullable<GatewayRequestHandlerOptions["client"]>;
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
        assertCurrent() {
          if (!roleCurrent) throw new Error("named role revoked");
        },
      },
    });
    await entered.promise;
    if (cause === "transport") connected = false;
    else if (cause === "role") roleCurrent = false;
    else if (cause === "expired") now = 1;
    else grant.abort(new Error(cause));
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

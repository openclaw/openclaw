import { getPublicKey } from "nostr-tools";
import { npubEncode } from "nostr-tools/nip19";
import type { dispatchInboundDirectDm as DispatchInboundDirectDm } from "openclaw/plugin-sdk/channel-inbound";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { expect, it, vi } from "vitest";
import { getActiveNostrBuses, startNostrGatewayAccount } from "./gateway.js";
import {
  createSignedNostrDm as dm,
  useNostrAdmissionFixture,
} from "./nostr-bus.admission.test-support.js";
import { buildResolvedNostrAccount, TEST_HEX_PRIVATE_KEY_BYTES } from "./test-fixtures.js";
import type { ResolvedNostrAccount } from "./types.js";

const agent = vi.hoisted(() => ({
  dispatch: vi.fn<(params: Parameters<typeof DispatchInboundDirectDm>[0]) => Promise<void>>(),
}));
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  dispatchInboundDirectDm: agent.dispatch,
}));

// Registered by the SQLite-owning outbound suite; only downstream agent dispatch is stubbed.
export function registerNostrGatewayAdmissionTests() {
  const fixture = useNostrAdmissionFixture();
  const approved = new Uint8Array(32).fill(2);
  const other = new Uint8Array(32).fill(3);
  const recipient = getPublicKey(TEST_HEX_PRIVATE_KEY_BYTES);
  const key = getPublicKey(approved);
  const whenLogged = (part: string, resolve: () => void) => (message: string) => {
    if (message.includes(part)) {
      resolve();
    }
  };
  async function start(config: ResolvedNostrAccount["config"], stateDir?: string) {
    const h = await fixture.create(stateDir);
    const { relay, runtime, errors } = h;
    const abort = new AbortController();
    const started = createDeferred<void>();
    const delivered = createDeferred<void>();
    const blocked = createDeferred<void>();
    agent.dispatch.mockReset().mockImplementation(async () => delivered.resolve());
    const context = createStartAccountContext({
      account: buildResolvedNostrAccount({ publicKey: recipient, relays: [relay.url], config }),
      cfg: { channels: { nostr: config } },
      abortSignal: abort.signal,
    });
    context.channelRuntime = runtime.channel;
    context.log = {
      warn: vi.fn(),
      debug: whenLogged("blocked Nostr sender", blocked.resolve),
      info: whenLogged("Nostr provider started", started.resolve),
      error: (message) => errors.push(message),
    };
    const task = startNostrGatewayAccount(context);
    // Register teardown before waiting for startup; failures cannot leak a socket or monitor.
    h.onStop(async () => {
      abort.abort();
      await task;
    });
    await withTimeout(Promise.all([started.promise, relay.subscribed]), 5000);
    return { ...h, dispatch: agent.dispatch, delivered, blocked };
  }

  async function finish(h: Awaited<ReturnType<typeof start>>, ids: string[]) {
    await h.stop();
    expect(h.ids).toEqual(ids);
    expect(getActiveNostrBuses().has("default")).toBe(false);
  }

  it("keeps normalized allowlists across an outsider burst and an abort/join restart", async () => {
    const stateDir = fixture.directory();
    const h = await start(
      {
        dmPolicy: "allowlist",
        allowFrom: [key.toUpperCase(), " nostr:" + npubEncode(key) + " ", key],
      },
      stateDir,
    );
    const denied = Array.from({ length: 200 }, (_, i) => dm(other, "denied-" + i));
    const allowed = dm(approved, "approved through Gateway");
    const forged = { ...dm(other, "forged"), pubkey: key };
    h.relay.sendIncoming([...denied, forged, allowed]);
    await withTimeout(h.delivered.promise, 5000);
    await finish(h, [allowed.id]);
    expect(h.errors).toEqual([]);
    expect(h.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ rawBody: "approved through Gateway", senderId: key }),
    );
    expect(h.relay.subscriptions).toEqual([[{ kinds: [4], "#p": [recipient], since: 0 }]]);
    const next = await start({ dmPolicy: "allowlist", allowFrom: [getPublicKey(other)] }, stateDir);
    const newAllowed = dm(other, "new allowed");
    next.relay.sendIncoming([dm(approved, "old denied after restart"), newAllowed]);
    await withTimeout(next.delivered.promise, 5000);
    await finish(next, [newAllowed.id]);
    expect(next.errors).toEqual([]);
    expect(next.dispatch).toHaveBeenCalledOnce();
  });

  it("keeps canonical Gateway authorization authoritative for a matching admission author", async () => {
    const config: ResolvedNostrAccount["config"] = { dmPolicy: "allowlist", allowFrom: [key] };
    const h = await start(config);
    // Exercise the existing current-policy recheck, not a running-server reload.
    config.dmPolicy = "disabled";
    const event = dm(approved, "matching hint is not authorization");
    h.relay.sendIncoming([event]);
    await withTimeout(h.blocked.promise, 5000);
    await finish(h, [event.id]);
    expect(h.errors).toEqual([]);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    { dmPolicy: "allowlist", allowFrom: [] },
    { dmPolicy: "allowlist", allowFrom: [key, 123] },
    { dmPolicy: "allowlist", allowFrom: [key, "*"] },
    { dmPolicy: "allowlist", allowFrom: [key, "accessGroup:friends"] },
    { dmPolicy: "allowlist", allowFrom: [key, "invalid"] },
    { dmPolicy: "allowlist", allowFrom: [key, ""] },
    { dmPolicy: "disabled", allowFrom: [key] },
  ] as const)(
    "durably admits nonmembers through Gateway when optimization is ineligible: %j",
    async (config) => {
      const h = await start({ ...config, allowFrom: [...config.allowFrom] });
      const event = dm(other, "canonical policy owns this event");
      h.relay.sendIncoming([event]);
      await withTimeout(h.enqueued.promise, 5000);
      if (config.dmPolicy === "disabled") {
        await withTimeout(h.blocked.promise, 5000);
      }
      await finish(h, [event.id]);
      // Admission is not authorization: the disabled policy must never dispatch.
      if (config.dmPolicy === "disabled") {
        expect(h.dispatch).not.toHaveBeenCalled();
      }
    },
  );
}

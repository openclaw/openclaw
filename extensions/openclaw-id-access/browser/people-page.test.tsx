/* @vitest-environment jsdom */

import { formatEd25519PublicKey } from "@openclaw/openclaw-id-protocol";
import { render } from "@solidjs/web";
import type * as UI from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeoplePage } from "./people-page.js";
import type { StatusResult } from "./types.js";

// Signing needs this browser's owner key from IndexedDB; the tests stand in for it.
vi.mock("./owner-signing.js", () => ({
  thisOwnerDevice: vi.fn(async (link: { ownerDevices?: Array<{ devicePub: string }> }) =>
    link.ownerDevices?.find((device) => device.devicePub === "ed25519:mine"),
  ),
  signMembershipChange: vi.fn(async (_link: unknown, target: unknown) => ({ signed: target })),
  signAsOwner: vi.fn(async () => ({ signed: "cap" })),
}));

const { default: plugin } = await import("./index.js");
const disposers: Array<() => void> = [];

const pendingInvite = {
  inviteId: "inv-1",
  label: "member@example.test",
  role: "operator",
  audience: { kind: "email", value: "member@example.test" },
  createdAt: 1_800_000_000,
  expiresAt: 1_800_600_000,
  status: "pending",
  pending: {
    accountId: "acct-member",
    devicePub: formatEd25519PublicKey(new Uint8Array(32).fill(7)),
    peerKey: "iroh:member",
    requestedAt: 1_800_000_100,
    decideBy: 1_800_086_400,
    reported: { email: "member@example.test", displayName: "Mia", locationHint: "Falkenstein, DE" },
  },
};

function linked(overrides: Partial<StatusResult["link"]> = {}): StatusResult {
  return {
    status: { state: "on" },
    channel: "tunnel",
    owner: true,
    link: {
      linked: true,
      clawId: "claw-1",
      hostname: "studio-e61zr.crabd.xyz",
      rootPub: "ed25519:root",
      seq: 4,
      ownerDevices: [
        { devicePub: "ed25519:mine", label: "This browser", peerKeys: ["iroh:a"], cert: {} },
        { devicePub: "ed25519:old-laptop", label: "Old laptop", peerKeys: ["iroh:b"], cert: {} },
      ],
      members: [],
      invites: [pendingInvite as never],
      ...overrides,
    },
  };
}

// Activates the plugin, mounts its page and returns the host's request spy.
// Activation reads the status once (the flag gate) before the page reads its own.
function hostFor(statuses: StatusResult[], submitResult: unknown = {}) {
  // openclawId.people answers with the link of the status last read (owner only).
  let last: StatusResult | undefined;
  const request = vi.fn(async (method: string) => {
    if (method === "openclawId.status") {
      last = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { ...last, link: { linked: last!.link.linked, hostname: last!.link.hostname } };
    }
    if (method === "openclawId.people") {
      return { link: last!.link };
    }
    return submitResult;
  });
  const disposePage = vi.fn();
  const disposeNavigation = vi.fn();
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => disposePage);
  const registerNavigation = vi.fn(() => disposeNavigation);
  const subscribers = new Set<() => void>();
  const events = new Map<string, Set<(payload: unknown) => void>>();
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: true },
    request,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    onEvent: (event: string, listener: (payload: unknown) => void) => {
      const listeners = events.get(event) ?? new Set();
      events.set(event, listeners);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sessions: {
      rows: [{ key: "agent:main:trip", derivedTitle: "Trip ideas" }],
      normalizeKey: (key: string) => key,
    },
    ui: { registerPage, registerNavigation },
  } as unknown as UI.ControlUiHost;
  return {
    host,
    request,
    registerPage,
    registerNavigation,
    disposePage,
    disposeNavigation,
    controller,
    subscribers,
    events,
    emit: () => events.get("openclawId.people.changed")?.forEach((listener) => listener({})),
    connect: (connected: boolean) => {
      host.connection.connected = connected;
      subscribers.forEach((listener) => listener());
    },
  };
}

async function mountPage(statuses: StatusResult[], submitResult?: unknown) {
  const harness = hostFor([statuses[0]!, ...statuses], submitResult);
  const { host, request, registerPage, controller } = harness;
  const stop = await plugin.activate(host);
  if (typeof stop === "function") {
    disposers.push(stop);
  }
  await vi.waitFor(() => expect(registerPage).toHaveBeenCalled());
  const [page] = registerPage.mock.calls[0]!;
  expect(page).toMatchObject({ id: "people", label: "People" });
  const container = document.createElement("div");
  document.body.append(container);
  const view = page.mount(container, {
    host,
    props: {},
    signal: controller.signal,
    presented: true,
  } as UI.ControlUiViewContext);
  const dispose = () => view?.dispose?.();
  disposers.push(dispose);
  return { ...harness, request, container, dispose };
}

const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);

describe("People page", () => {
  afterEach(() => {
    disposers
      .splice(0)
      .toReversed()
      .forEach((dispose) => dispose());
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  it("registers no page while OpenClaw ID is off", async () => {
    const { host, request, registerPage } = hostFor([
      { status: { state: "off" }, channel: null, link: { linked: false } },
    ]);
    await plugin.activate(host);
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith("openclawId.status", {}));
    await Promise.resolve();
    expect(registerPage).not.toHaveBeenCalled();
  });

  it("shows who is asking, from which device, and which invite they used", async () => {
    const { container } = await mountPage([linked()]);
    await vi.waitFor(() =>
      expect(container.textContent).toMatch(/Device fingerprint: fp:[a-f0-9]{64}/),
    );
    expect(container.textContent).toContain("Operator invite · created");
    expect(container.textContent).toContain(
      "member@example.test · browser unavailable on unknown OS · Falkenstein, DE",
    );
    expect(container.textContent?.match(/member@example.test/g)).toHaveLength(1);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details code")?.textContent).toMatch(/^fp:[a-f0-9]{64}$/);
    expect(container.querySelector("header")?.textContent?.trim()).toBe("People");
    expect(button(container, "Refresh")).toBeUndefined();
    // Owner devices live in the account menu, not on People.
    expect(container.textContent).not.toContain("Old laptop");
  });

  it("approves a pending request with an owner-signed change", async () => {
    const { container, request } = await mountPage([
      linked(),
      linked({
        invites: [],
        members: [
          {
            accountId: "acct-member",
            role: "operator",
            peerKeys: ["iroh:member"],
            email: "member@example.test",
          },
        ],
      }),
    ]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("member@example.test · browser unavailable"),
    );
    await vi.waitFor(() => expect(button(container, "Approve")?.disabled).toBe(false));
    button(container, "Approve")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: {
          signed: {
            op: "add",
            account_id: "acct-member",
            role: "operator",
            peer_keys: ["iroh:member"],
            invite_id: "inv-1",
          },
        },
      }),
    );
    await vi.waitFor(() => expect(container.textContent).toContain("member@example.test"));
    expect(container.textContent).toContain("No one is waiting for approval.");
  });

  it("shows each member's devices and what they are running, and says what a removal cut", async () => {
    const member = {
      accountId: "acct-bob",
      role: "operator",
      peerKeys: ["iroh:bob"],
      email: "bob@example.test",
      displayName: "Bob",
      approvedAt: 1_800_000_000,
      devices: [
        {
          peerKey: "iroh:bob",
          connections: 1,
          lastSeenAt: Date.now(),
          runs: [{ runId: "r1", sessionKey: "agent:main:trip" }],
        },
      ],
    };
    const { container, request } = await mountPage(
      [linked({ invites: [], members: [member] }), linked({ invites: [], members: [] })],
      { removal: { devices: 1, connectionsClosed: 1, runsCancelled: 1 } },
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "bob@example.test · 1 device · active now · running “Trip ideas”",
      ),
    );
    await vi.waitFor(() => expect(button(container, "Remove")?.disabled).toBe(false));
    button(container, "Remove")!.click();
    await vi.waitFor(() => expect(button(container, "Remove Bob")).toBeDefined());
    expect(request).not.toHaveBeenCalledWith("openclawId.authority", expect.anything());
    button(container, "Remove Bob")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: { signed: { op: "remove", account_id: "acct-bob" } },
      }),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bob removed · 1 connection closed · 1 run stopped"),
    );
  });

  it("signs a removal at the claw's current seq, not the one the page last read", async () => {
    const member = {
      accountId: "acct-bob",
      role: "operator",
      peerKeys: ["iroh:bob"],
      email: "bob@example.test",
      displayName: "Bob",
      approvedAt: 1_800_000_000,
      devices: [],
    };
    const { container, request } = await mountPage([
      linked({ invites: [], members: [member], seq: 4 }),
    ]);
    await vi.waitFor(() => expect(button(container, "Remove")?.disabled).toBe(false));
    // Something else changed the claw after the page read it (seq 4 -> 6).
    request.mockImplementation(async (method: string) =>
      method === "openclawId.people"
        ? { link: linked({ invites: [], members: [member], seq: 6 }).link }
        : method === "openclawId.status"
          ? { ...linked(), link: { linked: true, hostname: "studio-e61zr.crabd.xyz" } }
          : {},
    );
    button(container, "Remove")!.click();
    await vi.waitFor(() => expect(button(container, "Remove Bob")).toBeDefined());
    button(container, "Remove Bob")!.click();
    const { signMembershipChange } = await import("./owner-signing.js");
    await vi.waitFor(() =>
      expect(signMembershipChange).toHaveBeenLastCalledWith(expect.objectContaining({ seq: 6 }), {
        op: "remove",
        account_id: "acct-bob",
      }),
    );
  });

  it("shows no people to a client that is not an owner, and never asks for them", async () => {
    const { host, request } = hostFor([{ ...linked(), owner: false }]);
    const container = document.createElement("div");
    document.body.append(container);
    disposers.push(render(() => <PeoplePage host={host} />, container));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Only an owner device of this claw can see who has access.",
      ),
    );
    expect(request).not.toHaveBeenCalledWith("openclawId.people", {});
    expect(container.textContent).not.toContain("member@example.test");
  });

  it("is read-only in a browser that is not an owner device", async () => {
    const status = linked({
      ownerDevices: [{ devicePub: "ed25519:other", label: "Other", peerKeys: [], cert: {} }],
    });
    const { container } = await mountPage([status]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("is not an owner device for this claw"),
    );
    expect(button(container, "Approve")?.disabled).toBe(true);
  });

  it("registers only owner Pages navigation, and removes it on disconnect", async () => {
    const harness = await mountPage([linked()]);
    expect(harness.registerNavigation).toHaveBeenCalledWith({
      id: "people",
      label: "People",
      page: { id: "people" },
      icon: "users",
      defaultVisible: false,
    });
    harness.connect(false);
    await vi.waitFor(() => expect(harness.disposeNavigation).toHaveBeenCalledTimes(1));
    expect(harness.disposePage).toHaveBeenCalledTimes(1);
    harness.request.mockResolvedValue({ ...linked(), owner: false });
    harness.connect(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.registerPage).toHaveBeenCalledTimes(1);
    expect(harness.registerNavigation).toHaveBeenCalledTimes(1);
  });

  it("debounces bursts, removes departed members, and does not poll", async () => {
    const member = { accountId: "a", role: "viewer", peerKeys: [], email: "a@example.test" };
    const harness = await mountPage([
      linked({ invites: [], members: [member] }),
      linked({ invites: [] }),
    ]);
    await vi.waitFor(() => expect(harness.container.textContent).toContain(member.email));
    vi.useFakeTimers();
    const reads = () =>
      harness.request.mock.calls.filter(([method]) => method === "openclawId.people").length;
    expect(reads()).toBe(1);
    harness.emit();
    await vi.advanceTimersByTimeAsync(100);
    harness.emit();
    harness.emit();
    await vi.advanceTimersByTimeAsync(249);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    flush();
    expect(reads()).toBe(2);
    expect(harness.container.textContent).not.toContain(member.email);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(2);
  });

  it("retains one trailing read for invalidation during an in-flight response", async () => {
    const harness = await mountPage([linked({ invites: [] })]);
    await vi.waitFor(() => expect(harness.container.textContent).toContain("No one is waiting"));
    vi.useFakeTimers();
    const held = Promise.withResolvers<unknown>();
    let reads = 0;
    harness.request.mockImplementation(async (method: string) => {
      if (method === "openclawId.people") {
        reads += 1;
        return reads === 1
          ? held.promise
          : {
              link: linked({
                invites: [],
                members: [
                  {
                    accountId: "latest",
                    email: "latest@example.test",
                    role: "viewer",
                    peerKeys: [],
                  },
                ],
              }).link,
            };
      }
      return linked({ invites: [] });
    });
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    harness.emit();
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    expect(reads).toBe(1);
    held.resolve({ link: linked({ invites: [] }).link });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(reads).toBe(2);
    expect(harness.container.textContent).toContain("latest@example.test");
  });

  it("refetches on reconnect and ignores the previous connection's late response", async () => {
    const harness = await mountPage([linked({ invites: [] })]);
    await vi.waitFor(() => expect(harness.container.textContent).toContain("No one is waiting"));
    vi.useFakeTimers();
    const held = Promise.withResolvers<unknown>();
    let reads = 0;
    harness.request.mockImplementation(async (method: string) => {
      if (method === "openclawId.people") {
        reads += 1;
        return reads === 1
          ? held.promise
          : {
              link: linked({
                invites: [],
                members: [
                  { accountId: "new", email: "new@example.test", role: "viewer", peerKeys: [] },
                ],
              }).link,
            };
      }
      return linked({ invites: [] });
    });
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    harness.connect(false);
    harness.connect(true);
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(reads).toBe(2);
    expect(harness.container.textContent).toContain("new@example.test");
    held.resolve({ link: linked({ invites: [pendingInvite as never] }).link });
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expect(harness.container.textContent).toContain("new@example.test");
    expect(harness.container.textContent).not.toContain("member@example.test");

    const retired = Promise.withResolvers<unknown>();
    harness.request.mockImplementation(async (method: string) =>
      method === "openclawId.people" ? retired.promise : linked({ invites: [] }),
    );
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    harness.emit();
    harness.dispose();
    const before = harness.request.mock.calls.length;
    retired.resolve({ link: linked().link });
    await vi.advanceTimersByTimeAsync(1_000);
    flush();
    expect(harness.container.textContent).toBe("");
    expect(harness.request).toHaveBeenCalledTimes(before);
  });

  it("shows live-read errors and clears them after the next successful event", async () => {
    const harness = await mountPage([linked({ invites: [] })]);
    await vi.waitFor(() => expect(harness.container.textContent).toContain("No one is waiting"));
    vi.useFakeTimers();
    harness.request.mockRejectedValueOnce(new Error("People unavailable"));
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    flush();
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe(
      "People unavailable",
    );
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    flush();
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
  });

  it("releases event and connection listeners and cancels queued reads on disposal", async () => {
    const harness = await mountPage([linked({ invites: [] })]);
    await vi.waitFor(() => expect(harness.container.textContent).toContain("No one is waiting"));
    vi.useFakeTimers();
    harness.emit();
    const before = harness.request.mock.calls.length;
    harness.dispose();
    expect(harness.events.get("openclawId.people.changed")?.size).toBe(0);
    expect(harness.subscribers.size).toBe(1); // Plugin registration still owns its subscription.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.request).toHaveBeenCalledTimes(before);
    expect(harness.container.textContent).toBe("");
  });
});

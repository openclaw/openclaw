/* @vitest-environment jsdom */

import { formatEd25519PublicKey } from "@openclaw/openclaw-id-protocol";
import { render } from "@solidjs/web";
import type * as UI from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeopleMotion } from "./people-motion.js";
import { PeoplePage } from "./people-page.js";
import { InviteForm } from "./people-sections.js";
import type { Invite, StatusResult } from "./types.js";

// Signing needs this browser's owner key from IndexedDB; the tests stand in for it.
// mock-isolation: the owner device key lives in IndexedDB, which these page tests replace with a fixed signer.
vi.mock("./owner-signing.js", () => ({
  thisOwnerDevice: vi.fn(async (link: { ownerDevices?: Array<{ devicePub: string }> }) =>
    link.ownerDevices?.find((device) => device.devicePub === "ed25519:mine"),
  ),
  signMembershipChange: vi.fn(async (_link: unknown, target: unknown) => ({ signed: target })),
  signAsOwner: vi.fn(async () => ({ signed: "cap" })),
}));

const { default: plugin } = await import("./index.js");
const disposers: Array<() => void> = [];

const pendingInvite: Invite = {
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
      invites: [pendingInvite],
      ...overrides,
    },
  };
}

// The host owns picker behavior; this adapter exposes its public selection contract here.
const mountSelectPicker: UI.ControlUiHost["components"]["mountSelectPicker"] = (
  container,
  initial,
) => {
  const select = document.createElement("select");
  select.setAttribute("aria-label", initial.accessibleLabel);
  let current = initial;
  const update = (next: typeof initial) => {
    current = next;
    select.replaceChildren(
      ...next.options.map((option) => {
        const element = document.createElement("option");
        element.value = option.value;
        element.textContent = `${option.label} · ${option.description}`;
        return element;
      }),
    );
    select.value = next.value;
    select.disabled = next.disabled ?? false;
  };
  select.addEventListener("change", () => current.onSelect(select.value));
  container.append(select);
  update(initial);
  return { update, dispose: () => select.remove() };
};

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
    redact: (text: string) => text.replace(/Bearer \S+/g, "Bearer [redacted]"),
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
    components: { mountSelectPicker },
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
  expect(page).toMatchObject({ id: "access", label: "Remote access" });
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

describe("Access page", () => {
  afterEach(() => {
    disposers
      .splice(0)
      .toReversed()
      .forEach((dispose) => dispose());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("directs unlinked owners to turn on remote access on the claw's computer", async () => {
    const { container, request } = await mountPage([linked({ linked: false })]);
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Turn on remote access before inviting people."),
    );
    expect(container.textContent).toContain("On the computer that runs this claw");
    expect(container.textContent).not.toMatch(/Make reachable|Control UI/);
    expect(request).not.toHaveBeenCalledWith("openclawId.people", {});
  });

  it("keeps invite expiry, permission ceiling, private sharing and owner approval explicit", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onCreate = vi.fn(async () => ({
      email: "friend@example.test",
      url: "https://example.test/#synthetic-invite",
      expiresAt: 1_800_600_000,
    }));
    disposers.push(
      render(
        () => (
          <InviteForm
            motion={createPeopleMotion()}
            components={hostFor([linked()]).host.components}
            disabled={false}
            locale="en-US"
            onCreate={onCreate}
          />
        ),
        container,
      ),
    );
    const input = container.querySelector("input")!;
    input.value = "friend@example.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.textContent).toContain("The link expires in 7 days.");
    expect(container.textContent).toContain("Invites cannot grant owner access.");
    expect(container.querySelector('option[value="operator"]')?.textContent).toBe(
      "Operator · Chat, run tools, and use connected services",
    );
    expect(container.querySelector('option[value="owner"]')).toBeNull();
    const picker = container.querySelector("select")!;
    picker.value = "viewer";
    picker.dispatchEvent(new Event("change"));
    flush();
    button(container, "Create invite link")!.click();
    await vi.waitFor(() => expect(container.textContent).toContain("Send this link privately."));
    expect(container.textContent).toContain(
      "Anyone with it can request access, but only you can approve them.",
    );
    expect(onCreate).toHaveBeenCalledWith("friend@example.test", "viewer");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).toContain("Viewer invite · expires");
    button(container, "Invite someone")!.click();
    flush();
    expect(container.querySelector("input")?.value).toBe("");
    expect(document.activeElement).toBe(container.querySelector("input"));
    expect(container.querySelector("select")?.value).toBe("operator");
    expect(container.textContent).not.toContain("https://example.test/#synthetic-invite");
  });

  it("shows who is asking, from which device, and which invite they used", async () => {
    const { container } = await mountPage([linked()]);
    await vi.waitFor(() => expect(container.textContent).toMatch(/Device ID: fp:[a-f0-9]{64}/));
    expect(container.textContent).toContain("Operator invite · Falkenstein, DE · decide by");
    expect(container.textContent).toContain("member@example.test");
    expect(container.textContent).toContain("Falkenstein, DE");
    expect(container.textContent?.match(/member@example.test/g)).toHaveLength(1);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details code")?.textContent).toMatch(/^fp:[a-f0-9]{64}$/);
    expect(container.querySelector("details")?.textContent).toContain(
      "OpenClaw ID provided this email and approximate location. Device details are unavailable.",
    );
    expect(container.querySelector("header h1")?.textContent).toBe("Remote access");
    expect(container.querySelector("#ocid-access-people")?.textContent).toBe("People");
    expect(button(container, "Add node")?.disabled).toBe(false);
    expect(
      container.querySelector('[aria-labelledby="ocid-access-people"] #ocid-nodes'),
    ).toBeNull();
    expect(button(container, "Refresh")).toBeUndefined();
    // Owner devices live in the account menu, not on the Access page.
    expect(container.textContent).not.toContain("Old laptop");
  });

  it("keeps node controls usable while only the invite card is creating", async () => {
    const pending = Promise.withResolvers<object>();
    const { container, request } = await mountPage(
      [
        linked({
          rootPub: pendingInvite.pending!.devicePub,
          nodes: [
            {
              peerKey: "iroh:node",
              label: "Office",
              description: { display_name: "office", platform: "linux", commands: [], caps: [] },
              addedBy: "root",
              lastSeen: 1_800_000_000,
              inviteId: "old",
            },
          ],
          nodeInvites: [
            {
              inviteId: "node-open",
              label: "Build box",
              status: "open",
              createdAt: 1_800_000_000,
              expiresAt: 1_800_600_000,
            },
          ],
        }),
      ],
      pending.promise,
    );
    await vi.waitFor(() => expect(button(container, "Add node")?.disabled).toBe(false));
    const input = container.querySelector("input")!;
    input.value = "friend@example.test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const create = button(container, "Create invite link")!;
    create.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "openclawId.authority",
        expect.objectContaining({ action: "register_invite" }),
      ),
    );
    expect(create.disabled).toBe(true);
    expect(create.getAttribute("aria-busy")).toBe("true");
    expect(create.querySelector(".btn__spinner")).not.toBeNull();
    expect(input.disabled).toBe(true);
    expect(container.querySelector("select")?.disabled).toBe(true);
    for (const label of ["Add node", "Remove node", "Review node", "Approve", "Deny"]) {
      expect(button(container, label)?.disabled, label).toBe(false);
    }
    button(container, "Remove node")!.click();
    await vi.waitFor(() => expect(button(container, "Remove Office")).toBeDefined());
    button(container, "Remove Office")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: { signed: { op: "remove_node", peer_key: "iroh:node" } },
      }),
    );
    pending.resolve({});
    await vi.waitFor(() => expect(container.textContent).toContain("Send this link privately."));
    expect(button(container, "Add node")?.disabled).toBe(false);
  });

  it.each(["operator", "viewer", "guest"])(
    "approves a pending %s request with its exact owner-signed role",
    async (role) => {
      const { container, request } = await mountPage([
        linked({ invites: [{ ...pendingInvite, role }] }),
        linked({
          invites: [],
          members: [
            {
              accountId: "acct-member",
              role,
              peerKeys: ["iroh:member"],
              email: "member@example.test",
            },
          ],
        }),
      ]);
      await vi.waitFor(() => expect(container.textContent).toContain("member@example.test"));
      await vi.waitFor(() => expect(button(container, "Approve")?.disabled).toBe(false));
      button(container, "Approve")!.click();
      await vi.waitFor(() =>
        expect(request).toHaveBeenCalledWith("openclawId.authority", {
          action: "submit",
          statement: {
            signed: {
              op: "add",
              account_id: "acct-member",
              role,
              peer_keys: ["iroh:member"],
              invite_id: "inv-1",
            },
          },
        }),
      );
      await vi.waitFor(() => expect(container.textContent).toContain("member@example.test"));
      await vi.waitFor(() =>
        expect(container.textContent).toContain("No one is waiting for approval."),
      );
    },
  );

  it.each([false, true])(
    "finishes a decided row's exit before replacing it (reduced=%s)",
    async (reduced) => {
      vi.stubGlobal("matchMedia", () => ({ matches: reduced }));
      const { container } = await mountPage([linked(), linked({ invites: [] })]);
      await vi.waitFor(() => expect(button(container, "Deny")?.disabled).toBe(false));
      const row = container.querySelector(".ocid-access__row--request")!;
      vi.useFakeTimers();
      button(container, "Deny")!.click();
      await vi.advanceTimersByTimeAsync(0);
      flush();
      if (!reduced) {
        expect(row.isConnected).toBe(true);
        expect(button(container, "Deny")?.disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(279);
        expect(row.isConnected).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        flush();
      }
      expect(row.isConnected).toBe(false);
      expect(container.textContent).toContain("No one is waiting for approval.");
    },
  );

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
      [
        linked({ invites: [{ ...pendingInvite, status: "open" }], members: [member] }),
        linked({ invites: [], members: [] }),
      ],
      { removal: { devices: 1, connectionsClosed: 1, runsCancelled: 1 } },
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "bob@example.test · 1 device · active now · running “Trip ideas”",
      ),
    );
    const rows = [...container.querySelectorAll('[aria-labelledby="ocid-access-members"] li')];
    expect(rows.map((row) => row.querySelector(".ocid-access__title")?.textContent)).toEqual([
      "You",
      "member@example.test",
      "Bob",
    ]);
    expect(rows.map((row) => row.querySelectorAll(".chip").length)).toEqual([1, 1, 1]);
    expect(rows[1]?.textContent).toContain("Not accepted yet · expires");
    await vi.waitFor(() => expect(button(container, "Remove")?.disabled).toBe(false));
    button(container, "Remove")!.click();
    await vi.waitFor(() => expect(button(container, "Remove Bob")).toBeDefined());
    expect(request).not.toHaveBeenCalledWith("openclawId.authority", expect.anything());
    expect(container.textContent).toContain(
      "Their devices disconnect now, and their running tasks stop.",
    );
    expect(container.textContent).toContain(
      "Completed work and conversations stay here. They need a new invite to return.",
    );
    button(container, "Remove Bob")!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("openclawId.authority", {
        action: "submit",
        statement: { signed: { op: "remove", account_id: "acct-bob" } },
      }),
    );
    await vi.waitFor(() =>
      expect(container.textContent).toContain("Bob removed · 1 connection closed · 1 task stopped"),
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
        "Only the owner can see who has access. Open this page from an approved owner browser.",
      ),
    );
    expect(request).not.toHaveBeenCalledWith("openclawId.people", {});
    expect(container.textContent).not.toContain("member@example.test");
    expect(button(container, "Add node")).toBeUndefined();
  });

  it("is read-only in a browser that is not an owner device", async () => {
    const status = linked({
      ownerDevices: [{ devicePub: "ed25519:other", label: "Other", peerKeys: [], cert: {} }],
      members: [
        { accountId: "reader", email: "reader@example.test", role: "viewer", peerKeys: [] },
      ],
    });
    const { container } = await mountPage([status]);
    await vi.waitFor(() => expect(container.textContent).toContain("Waiting for approval"));
    expect(container.querySelector(".callout")).toBeNull();
    expect(button(container, "Approve")).toBeUndefined();
    expect(button(container, "Deny")).toBeUndefined();
    expect(button(container, "Remove")).toBeUndefined();
    expect(button(container, "Create invite link")).toBeUndefined();
    expect(button(container, "Add node")).toBeUndefined();
  });

  it("registers only owner Pages navigation, and removes it on disconnect", async () => {
    const harness = await mountPage([linked()]);
    expect(harness.registerNavigation).toHaveBeenCalledWith({
      id: "access",
      label: "Access",
      page: { id: "access" },
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
    held.resolve({ link: linked({ invites: [pendingInvite] }).link });
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
    const alert = harness.container.querySelector('[role="alert"]');
    expect(alert?.querySelector("p")?.textContent).toBe(
      "Could not load people. Refresh this page to try again.",
    );
    expect(alert?.querySelector("details")?.open).toBe(false);
    expect(alert?.querySelector("summary")?.textContent).toBe("Technical details");
    expect(alert?.querySelector("code")?.textContent).toBe("People unavailable");
    alert!.querySelector("details")!.open = true;
    harness.request.mockRejectedValueOnce(
      Object.assign(new Error("<img src=x> private diagnostic"), {
        code: "INVALID_REQUEST",
        details: { code: "not_owner" },
      }),
    );
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    flush();
    const nextAlert = harness.container.querySelector('[role="alert"]');
    expect(nextAlert?.querySelector("p")?.textContent).toContain(
      "Only the owner can see who has access.",
    );
    expect(nextAlert?.querySelector("details")?.open).toBe(false);
    expect(nextAlert?.querySelector("code")?.textContent).toContain("<img src=x>");
    expect(nextAlert?.querySelector("img")).toBeNull();
    harness.emit();
    await vi.advanceTimersByTimeAsync(250);
    flush();
    expect(harness.container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([false, true])(
    "refreshes an uncertain approval without a blind retry (committed=%s)",
    async (committed) => {
      const harness = await mountPage([linked()]);
      await vi.waitFor(() => expect(button(harness.container, "Approve")?.disabled).toBe(false));
      const initialRequest = harness.request.getMockImplementation()!;
      let submitted = false;
      harness.request.mockImplementation(async (method: string) => {
        if (method === "openclawId.authority") {
          submitted = true;
          throw new Error(
            "handoff failed Bearer private-token https://example.test/#invite-secret",
          );
        }
        if (committed && submitted && method === "openclawId.people") {
          return {
            link: linked({
              invites: [],
              members: [
                {
                  accountId: "acct-member",
                  email: "member@example.test",
                  role: "operator",
                  peerKeys: [],
                },
              ],
            }).link,
          };
        }
        return initialRequest(method);
      });
      button(harness.container, "Approve")!.click();
      await vi.waitFor(() =>
        expect(harness.container.querySelector('[role="alert"]')).not.toBeNull(),
      );
      if (committed) {
        await vi.waitFor(() =>
          expect(harness.container.querySelector(".ocid-access__row--request")).toBeNull(),
        );
      }
      const alert = harness.container.querySelector('[role="alert"]')!;
      if (committed) {
        expect(alert.closest("li")).toBeNull();
      } else {
        expect(alert.closest("li")?.textContent).toContain("member@example.test");
      }
      expect(
        harness.container
          .querySelector("#ocid-nodes")
          ?.closest("section")
          ?.querySelector('[role="alert"]'),
      ).toBeNull();
      expect(alert.querySelector("p")?.textContent).toBe(
        "Could not confirm whether access was approved. Refresh this page and check the person's access before approving again.",
      );
      expect(alert.querySelector("details")?.open).toBe(false);
      expect(alert.querySelector("code")?.textContent).toContain("handoff failed");
      expect(alert.textContent).not.toMatch(/private-token|invite-secret|Try again/);
      expect(button(harness.container, "Approve")).toBeUndefined();
      expect(button(harness.container, "Deny")).toBeUndefined();
      button(harness.container, "Refresh")!.click();
      await vi.waitFor(() => expect(harness.container.querySelector('[role="alert"]')).toBeNull());
      expect(Boolean(button(harness.container, "Approve"))).toBe(!committed);
      expect(
        harness.request.mock.calls.filter(([method]) => method === "openclawId.authority"),
      ).toHaveLength(1);
    },
  );

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

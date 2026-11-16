import { formatEd25519PublicKey } from "@openclaw/openclaw-id-protocol";
import type { ControlUiHost as Host, ControlUiPage } from "openclaw/plugin-sdk/control-ui";
import { vi } from "vitest";
import type { Invite, StatusResult } from "./types.js";

export const pendingInvite: Invite = {
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

export function linked(overrides: Partial<StatusResult["link"]> = {}): StatusResult {
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
      roles: [
        {
          name: "operator",
          defined: true,
          sessions: "write",
          requiresSandbox: false,
          admin: false,
        },
        { name: "viewer", defined: true, sessions: "view", requiresSandbox: false, admin: false },
      ],
      members: [],
      invites: [pendingInvite],
      ...overrides,
    },
  };
}

export const button = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === label);

// The host owns picker behavior; this adapter exposes its public selection contract here.
const mountSelectPicker: Host["components"]["mountSelectPicker"] = (container, initial) => {
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
export function hostFor(statuses: StatusResult[], submitResult: unknown = {}) {
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
  const registerPage = vi.fn<(page: ControlUiPage) => () => void>(() => disposePage);
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
  } as unknown as Host;
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

export const rolePicker = (container: HTMLElement) =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Role"]');

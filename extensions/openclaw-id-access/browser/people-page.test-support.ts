import { formatEd25519PublicKey } from "@openclaw/openclaw-id-protocol";
import type * as UI from "openclaw/plugin-sdk/control-ui";
import { expect, vi } from "vitest";
import type { Invite, MemberRecoveryUse, StatusResult } from "./types.js";

export const { default: plugin } = await import("./index.js");
export const disposers: Array<() => void> = [];
import type { ControlUiHost as Host, ControlUiPage } from "openclaw/plugin-sdk/control-ui";

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

export const recoveryUse: MemberRecoveryUse = {
  seq: 8,
  accountId: "acct-mira",
  memberName: "Mira <Example>",
  deviceLabel: "Firefox <Linux>",
  peerKey: `iroh:${"1".repeat(64)}`,
  peerFp: `fp:${"1".repeat(64)}`,
  usedAt: 1_800_000_000,
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
    navigation: {
      pageHref: ({ id, params = {} }: UI.ControlUiPageTarget) =>
        `/console/plugin?${new URLSearchParams({ plugin: "openclaw-id-access", id, ...Object.fromEntries(Object.entries(params).map(([key, value]) => [`p.${key}`, value])) })}`,
      openPage: vi.fn(),
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
export async function mountPage(
  statuses: StatusResult[],
  submitResult?: unknown,
  params: Readonly<Record<string, string>> = {},
) {
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
  const context: UI.ControlUiViewContext = {
    host,
    props: params,
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  };
  const view = page.mount(container, context);
  const dispose = () => view?.dispose?.();
  disposers.push(dispose);
  return {
    ...harness,
    request,
    container,
    dispose,
    update: (props: Readonly<Record<string, string>>) => view?.update?.({ ...context, props }),
  };
}


/* @vitest-environment jsdom */

import type * as UI from "openclaw/plugin-sdk/control-ui";
import { expect, it, onTestFinished, vi } from "vitest";
import plugin from "./control-ui.js";

const caller = {
  principal: { kind: "person", profileId: "person-alex" },
  principalLabel: "Alex",
  ceiling: ["operator.read", "operator.write"],
  canAdmin: false,
  canPair: true,
};
const grants = { grants: [], caller, relayUrl: "https://relay.example" };
const grant = {
  grantId: "grant-owned",
  clientName: "Personal app",
  principal: caller.principal,
  ceiling: ["operator.read"],
  createdAt: 1_800_000_000_000,
};
const ownedGrants = { ...grants, grants: [grant] };
const pairing = { code: "PAIR-CODE", expiresAt: 0, mcpUrl: "https://relay.test/mcp" };
const consent = { kind: "oauth", redirectHost: "app.test", expiresAt: 0, caller };
const body = () => document.body.textContent!;
const shows = (text: string) => vi.waitFor(() => expect(body()).toContain(text));
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === label);
const click = (label: string) => button(label)!.click();

function fixture(responses: unknown[], props: Record<string, string> = {}) {
  const subscribers = new Set<() => void>();
  const request = vi.fn(async () => responses.shift());
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: false },
    redact: (text: string) => text,
    request,
    subscribe: (listener: () => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    ui: { registerPage },
    components: {
      mountDialog: (container: HTMLElement, { content }: UI.ControlUiDialogProps) => {
        container.append(content);
        return { dispose: () => content.remove(), update: () => {} };
      },
    },
  } as unknown as UI.ControlUiHost;
  void plugin.activate(host);
  const [page] = registerPage.mock.calls[0]!;
  const context: UI.ControlUiViewContext = {
    host,
    props,
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  };
  const view = page.mount(document.body, context);
  onTestFinished(() => {
    controller.abort();
    view?.dispose?.();
    document.body.replaceChildren();
  });
  return {
    request,
    connection: host.connection,
    dispose: () => view?.dispose?.(),
    publish: () => subscribers.forEach((listener) => listener()),
    navigate: (requestId: string) => view?.update?.({ ...context, props: { request: requestId } }),
  };
}

it("retains focused grant controls on unrelated host updates and applies permission changes", async () => {
  const { connection, publish, request } = fixture([ownedGrants]);
  await shows("Personal app");
  const revoke = button("Revoke")!;
  revoke.focus();
  publish();
  expect(document.activeElement).toBe(revoke);
  expect(request).toHaveBeenCalledTimes(1);

  connection.canWrite = false;
  publish();
  expect(button("Revoke")).toBeUndefined();
  expect(body()).toContain("Personal app");

  connection.connected = false;
  publish();
  expect(body()).toContain("Connect to the Gateway to manage connected apps.");
  connection.connected = true;
  connection.canRead = false;
  publish();
  expect(body()).toContain("Read access is required to view connected apps.");
});

it("pairs within the caller's ceiling without a browser-supplied principal", async () => {
  const { request } = fixture([grants, pairing]);
  await shows("Pair with code");
  click("Pair with code");
  expect(body()).not.toContain("Full role access");
  click("Create pairing code");
  await shows("PAIR-CODE");
  expect(request).toHaveBeenLastCalledWith("mcp-relay.pair", {
    ceiling: ["operator.read", "operator.write"],
  });
  expect(body()).toContain("https://relay.test/mcp");
});

it("empties retained view roots and ignores detached controls and pending replies after disposal", async () => {
  const pending = Promise.withResolvers<unknown>();
  const { request, dispose, publish } = fixture([ownedGrants, pending.promise]);
  await shows("Personal app");
  const page = document.querySelector(".mcp-connected-apps")!;
  const overlay = page.nextElementSibling!;
  const pair = button("Pair with code")!;
  const revoke = button("Revoke")!;
  pair.click();
  const dialog = overlay.firstElementChild!;
  click("Create pairing code");
  expect(request).toHaveBeenCalledTimes(2);
  const pairingReply = request.mock.results[1]?.value;

  dispose();
  expect([page.childNodes.length, overlay.childNodes.length]).toEqual([0, 0]);
  expect(document.body.contains(page)).toBe(false);
  pair.click();
  revoke.click();
  publish();
  expect([page.childNodes.length, overlay.childNodes.length]).toEqual([0, 0]);

  pending.resolve(pairing);
  await pairingReply;
  expect(dialog.textContent).not.toContain("PAIR-CODE");
  expect(overlay.childNodes).toHaveLength(0);
  expect(request).toHaveBeenCalledTimes(2);
});

it("retains rows while refreshing and renders the authoritative reply on settlement", async () => {
  const pending = Promise.withResolvers<unknown>();
  const { request } = fixture([ownedGrants, pending.promise, grants]);
  await shows("Personal app");
  const row = document.querySelector(".mcp-connected-apps__grant");
  click("Refresh");
  expect(document.querySelector(".mcp-connected-apps__grant")).toBe(row);
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Loading connected apps…");
  expect(document.querySelectorAll("button:enabled, input:enabled")).toHaveLength(0);
  click("Revoke");
  expect(request).toHaveBeenCalledTimes(2);
  pending.reject(new Error("Try again"));
  await shows("Try again");
  click("Refresh");
  expect(document.querySelector('[role="alert"]')).toBeNull();
  await shows("No connected apps yet");
  expect(document.querySelector(".mcp-connected-apps__grant")).toBeNull();
  expect(button("Refresh")?.disabled).toBe(false);
});

it("escapes app labels and rejects foreign relay continuations", async () => {
  const clientName = '<img src=x onerror="alert(1)">';
  const { request } = fixture(
    [
      grants,
      { ...consent, clientName },
      { continueUrl: "https://foreign.example/oauth/continue?request=one" },
    ],
    { request: "one", relay: "https://foreign.example" },
  );
  await vi.waitFor(() => expect(button("Allow")?.disabled).toBe(false));
  expect(document.querySelector("img")).toBeNull();
  expect(body()).toContain(clientName);
  expect(body()).toContain("app.test");
  click("Allow");
  await shows("invalid return address");
  expect(request).toHaveBeenLastCalledWith("mcp-relay.authorize.approve", {
    requestId: "one",
    ceiling: ["operator.read", "operator.write"],
  });
});

it("ignores stale consent responses after navigation", async () => {
  const previous = Promise.withResolvers<unknown>();
  const { request, navigate } = fixture(
    [grants, previous.promise, grants, { ...consent, clientName: "Current app" }],
    { request: "old" },
  );
  await vi.waitFor(() =>
    expect(request).toHaveBeenCalledWith("mcp-relay.authorize.describe", { requestId: "old" }),
  );
  navigate("new");
  await shows("Connect Current app?");
  previous.resolve({ ...consent, clientName: "Old app" });
  await previous.promise;
  expect(body()).toContain("Connect Current app?");
  expect(body()).not.toContain("Old app");
});

it("revokes another person's grant as admin and shows the authoritative result", async () => {
  const otherGrant = {
    ...grant,
    grantId: "grant-other",
    clientName: "Team app",
    principal: { kind: "person", profileId: "person-other" },
    principalLabel: "Jordan Example",
  };
  const snapshot = { ...grants, grants: [otherGrant], caller: { ...caller, canAdmin: true } };
  const { request } = fixture([snapshot, { revoked: true }, { ...snapshot, grants: [] }]);
  await shows("Jordan Example");
  click("Revoke");
  await shows("Its MCP and embedded UI access has ended.");
  expect(request).toHaveBeenCalledWith("mcp-relay.revoke", { grantId: "grant-other" });
  expect(document.querySelector(".mcp-connected-apps__grant")).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toContain("Team app revoked.");
});

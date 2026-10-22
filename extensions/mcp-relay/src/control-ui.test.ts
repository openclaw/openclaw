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
const consent = {
  kind: "oauth",
  redirectHost: "app.example",
  expiresAt: 1_800_000_000_000,
  caller,
};
const body = () => document.body.textContent!;
const shows = (text: string) => vi.waitFor(() => expect(body()).toContain(text));
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === label);

function fixture(responses: unknown[], props: Record<string, string> = {}) {
  const request = vi.fn(async () => responses.shift());
  const registerPage = vi.fn<(page: UI.ControlUiPage) => () => void>(() => () => {});
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: false },
    redact: (text: string) => text,
    request,
    subscribe: () => () => {},
    ui: { registerPage },
    components: {
      mountDialog: (container: HTMLElement, { content }: UI.ControlUiDialogProps) => {
        container.append(content);
        return { dispose: () => content.remove(), update: () => {} };
      },
    },
  } as unknown as UI.ControlUiHost;
  void plugin.activate(host);
  const page = registerPage.mock.calls[0]?.[0];
  if (!page) {
    throw new Error("Connected apps page was not registered");
  }
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
    navigate: (requestId: string) => view?.update?.({ ...context, props: { request: requestId } }),
  };
}

function click(label: string) {
  const target = button(label);
  expect(target, `button ${label}`).toBeDefined();
  target?.click();
}

it("pairs within the caller's ceiling without a browser-supplied principal", async () => {
  const { request } = fixture([
    grants,
    {
      code: "ABCDE-FGHIJ",
      expiresAt: 1_800_000_000_000,
      mcpUrl: "https://relay.example/mcp",
    },
  ]);
  await shows("Pair with code");
  click("Pair with code");
  expect(body()).not.toContain("Full role access");
  click("Create pairing code");
  await shows("ABCDE-FGHIJ");
  expect(request).toHaveBeenLastCalledWith("mcp-relay.pair", {
    ceiling: ["operator.read", "operator.write"],
  });
  expect(body()).toContain("https://relay.example/mcp");
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
  expect(body()).toContain("app.example");
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
  const grant = {
    grantId: "grant-other",
    clientName: "Team app",
    principal: { kind: "person", profileId: "person-other" },
    principalLabel: "Jordan Example",
    ceiling: ["operator.read"],
    createdAt: 1_800_000_000_000,
  };
  const snapshot = { ...grants, grants: [grant], caller: { ...caller, canAdmin: true } };
  const { request } = fixture([snapshot, { revoked: true }, { ...snapshot, grants: [] }]);
  await shows("Team app");
  expect(body()).toContain("Jordan Example");
  click("Revoke");
  await shows("Its MCP and embedded UI access has ended.");
  expect(request).toHaveBeenCalledWith("mcp-relay.revoke", { grantId: "grant-other" });
  expect(document.querySelector(".mcp-connected-apps__grant")).toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe(
    "Team app revoked. Its MCP and embedded UI access has ended.",
  );
});

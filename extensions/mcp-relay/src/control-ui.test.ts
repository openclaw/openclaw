/* @vitest-environment jsdom */

import type {
  ControlUiDialogProps,
  ControlUiHost,
  ControlUiPage,
  ControlUiViewContext,
} from "openclaw/plugin-sdk/control-ui";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  clientName: "Example app",
  redirectHost: "app.example",
  expiresAt: 1_800_000_000_000,
  caller,
};
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
});

function rendered(predicate: () => boolean) {
  return vi.waitFor(() => expect(predicate()).toBe(true));
}

function fixture(request: ReturnType<typeof vi.fn>, props: Record<string, string> = {}) {
  let page: ControlUiPage | undefined;
  const controller = new AbortController();
  const host = {
    locale: "en-US",
    signal: controller.signal,
    connection: { connected: true, canRead: true, canWrite: true, canAdmin: false },
    redact: (text: string) => text,
    request,
    subscribe: () => () => {},
    ui: {
      registerPage: (entry: ControlUiPage) => {
        page = entry;
        return () => {};
      },
    },
    components: {
      mountDialog: (container: HTMLElement, input: ControlUiDialogProps) => {
        container.append(input.content);
        return { dispose: () => input.content.remove(), update: () => {} };
      },
    },
  } as unknown as ControlUiHost;
  void plugin.activate(host);
  if (!page) {
    throw new Error("Connected apps page was not registered");
  }
  const container = document.createElement("div");
  document.body.append(container);
  const context: ControlUiViewContext = {
    host,
    props,
    signal: controller.signal,
    presented: true,
    mountDefault: () => () => {},
  };
  const view = page.mount(container, context);
  cleanup.push(() => {
    controller.abort();
    view?.dispose?.();
  });
  return { context, view, container };
}

function click(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (node) => node.textContent === label,
  );
  expect(button, `button ${label}`).toBeDefined();
  button?.click();
}

describe("Connected apps native page", () => {
  it("pairs with the caller's read/write ceiling without accepting a principal from the browser", async () => {
    const request = vi.fn().mockResolvedValueOnce(grants).mockResolvedValueOnce({
      code: "ABCDE-FGHIJ",
      expiresAt: 1_800_000_000_000,
      mcpUrl: "https://relay.example/mcp",
    });
    fixture(request);
    await rendered(() => document.body.textContent!.includes("Pair with code"));
    click("Pair with code");
    expect(document.body.textContent).not.toContain("Full role access");
    click("Create pairing code");
    await rendered(() => document.body.textContent!.includes("ABCDE-FGHIJ"));
    expect(request).toHaveBeenLastCalledWith("mcp-relay.pair", {
      ceiling: ["operator.read", "operator.write"],
    });
    expect(document.body.textContent).toContain("https://relay.example/mcp");
  });

  it("renders untrusted app labels as text and rejects a continuation to an unconfigured relay", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(grants)
      .mockResolvedValueOnce({
        ...consent,
        clientName: '<img src=x onerror="alert(1)">',
      })
      .mockResolvedValueOnce({ continueUrl: "https://foreign.example/oauth/continue?request=one" });
    fixture(request, { request: "one", relay: "https://foreign.example" });
    await rendered(() =>
      [...document.querySelectorAll("button")].some(
        (node) => node.textContent === "Allow" && !node.disabled,
      ),
    );
    expect(document.querySelector("img")).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.body.textContent).toContain("app.example");
    click("Allow");
    await rendered(() => document.body.textContent!.includes("invalid return address"));
    expect(request).toHaveBeenLastCalledWith("mcp-relay.authorize.approve", {
      requestId: "one",
      ceiling: ["operator.read", "operator.write"],
    });
  });

  it("does not publish consent details from a previous request after navigation", async () => {
    const previous = createDeferred<unknown>();
    const describing = createDeferred<void>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(grants)
      .mockImplementationOnce(() => {
        describing.resolve();
        return previous.promise;
      })
      .mockResolvedValueOnce(grants)
      .mockResolvedValueOnce({ ...consent, clientName: "Current app" });
    const { view, context } = fixture(request, { request: "old" });
    await describing.promise;
    view?.update?.({ ...context, props: { request: "new" } });
    await rendered(() => document.body.textContent!.includes("Connect Current app?"));
    previous.resolve({ ...consent, clientName: "Old app" });
    await previous.promise;
    expect(document.body.textContent).toContain("Connect Current app?");
    expect(document.body.textContent).not.toContain("Old app");
  });

  it("lets an administrator revoke another person's grant and reflects the authoritative result", async () => {
    const grant = {
      grantId: "grant-other",
      clientName: "Team app",
      principal: { kind: "person", profileId: "person-other" },
      principalLabel: "Jordan Example",
      ceiling: ["operator.read"],
      createdAt: 1_800_000_000_000,
    };
    const snapshot = { ...grants, grants: [grant], caller: { ...caller, canAdmin: true } };
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce({ revoked: true })
      .mockResolvedValueOnce({ ...snapshot, grants: [] });
    fixture(request);
    await rendered(() => document.body.textContent!.includes("Team app"));
    expect(document.body.textContent).toContain("Jordan Example");
    click("Revoke");
    await rendered(() =>
      document.body.textContent!.includes("Its MCP and embedded UI access has ended."),
    );
    expect(request).toHaveBeenCalledWith("mcp-relay.revoke", { grantId: "grant-other" });
    expect(document.querySelector(".mcp-connected-apps__grant")).toBeNull();
    expect(document.querySelector('[role="status"]')?.textContent).toBe(
      "Team app revoked. Its MCP and embedded UI access has ended.",
    );
  });
});

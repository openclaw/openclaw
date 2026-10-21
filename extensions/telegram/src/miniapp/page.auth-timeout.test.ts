/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderTelegramMiniAppPage, TELEGRAM_MINIAPP_EXPIRED_MESSAGE } from "./page.js";

afterEach(() => {
  Reflect.deleteProperty(window, "Telegram");
  document.body.replaceChildren();
});

function preparePage(scriptNonce = "test-nonce") {
  const ready = vi.fn();
  const location = { hash: "#launchTicket=launch-ticket", replace: vi.fn() };
  const rendered = new DOMParser().parseFromString(
    renderTelegramMiniAppPage({ accountId: "ops", scriptNonce }),
    "text/html",
  );
  const script = rendered.querySelector("script:not([src])");
  const bootstrap = script?.textContent;
  if (!bootstrap) {
    throw new Error("generated Mini App page is missing its bootstrap script");
  }
  document.body.innerHTML = rendered.body.innerHTML;
  Object.defineProperty(window, "Telegram", {
    configurable: true,
    value: { WebApp: { initData: "signed-init-data", ready } },
  });
  return {
    rendered,
    script,
    ready,
    location,
    run(fetch: unknown, setTimer: unknown = setTimeout, clearTimer: unknown = clearTimeout) {
      // oxlint-disable-next-line typescript/no-implied-eval -- Execute the generated bootstrap, not a reimplementation.
      new Function(
        "{ window, document, AbortController, setTimeout, clearTimeout, fetch, location }",
        bootstrap,
      )({
        window,
        document,
        AbortController,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        fetch,
        location,
      });
    },
  };
}

describe("telegram miniapp page bootstrap", () => {
  it("keeps a hostile nonce inert while executing the page and expiring a hung auth request", async () => {
    const scheduleTimeout = vi
      .fn<(callback: () => void, delayMs: number) => number>()
      .mockReturnValue(1);
    const clearTimeoutSpy = vi.fn();
    const scriptNonce = `&<>"' data-nonce-injected="true"></script><img id="nonce-injection">`;
    const { rendered, script, ready, run } = preparePage(scriptNonce);
    expect(script?.getAttribute("nonce")).toBe(scriptNonce);
    expect(script?.getAttributeNames()).toEqual(["nonce"]);
    expect(rendered.querySelector("[data-nonce-injected], #nonce-injection")).toBeNull();
    const fetchMock = vi.fn(
      (_input: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    run(fetchMock, scheduleTimeout, clearTimeoutSpy);

    expect(ready).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "auth",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          initData: "signed-init-data",
          accountId: "ops",
          launchTicket: "launch-ticket",
        }),
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(scheduleTimeout.mock.calls[0]?.[1]).toBe(15_000);

    scheduleTimeout.mock.calls[0]?.[0]();

    await vi.waitFor(() => {
      expect(document.getElementById("status")?.textContent).toBe(TELEGRAM_MINIAPP_EXPIRED_MESSAGE);
    });
    expect(clearTimeoutSpy).toHaveBeenCalledWith(1);
  });

  it("redirects with the authenticated handoff", async () => {
    const { ready, location, run } = preparePage();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        bootstrapToken: "bootstrap-token",
        controlUiUrl: "https://host.tailnet.ts.net/openclaw",
        gatewayUrl: "wss://host.tailnet.ts.net",
      }),
    }));

    run(fetchMock);

    await vi.waitFor(() => {
      expect(location.replace).toHaveBeenCalledWith(
        "https://host.tailnet.ts.net/openclaw#gatewayUrl=wss%3A%2F%2Fhost.tailnet.ts.net&bootstrapToken=bootstrap-token",
      );
    });
    expect(ready).toHaveBeenCalledTimes(1);
  });
});

/* @vitest-environment jsdom */
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it, vi } from "vitest";
import { httpMock, mountRunner, setupAppBrowserTests } from "./app.browser.test-support.js";

setupAppBrowserTests();

describe("QA Lab tab navigation retention", () => {
  async function mountNavigation() {
    const snapshot: QaBusStateSnapshot = {
      conversations: [{ accountId: "default", id: "alice", kind: "direct" }],
      cursor: 0,
      events: [],
      messages: [],
      threads: [],
    };
    const root = await mountRunner(
      {
        alternateModel: "mock-openai/gpt-5.6-luna-alt",
        channel: null,
        channelDriver: "qa-channel",
        evidenceMode: "full",
        fastMode: false,
        primaryModel: "mock-openai/gpt-5.6-luna",
        profile: "all",
        providerMode: "mock-openai",
        runtimePair: null,
        runtimePairLane: null,
        scenarioIds: ["dm-chat-baseline"],
      },
      snapshot,
    );
    return { root, snapshot };
  }

  async function pollWithMessage(snapshot: QaBusStateSnapshot) {
    const message: QaBusStateSnapshot["messages"][number] = {
      accountId: "default",
      conversation: { id: "alice", kind: "direct" },
      direction: "inbound",
      id: `message-${snapshot.messages.length + 1}`,
      reactions: [],
      senderId: "alice",
      text: "new polling message",
      timestamp: 1,
    };
    snapshot.messages.push(message);
    snapshot.events.push({
      accountId: message.accountId,
      cursor: ++snapshot.cursor,
      kind: "inbound-message",
      message,
    });
    await vi.advanceTimersByTimeAsync(1_000);
  }

  function mockTabGeometry(root: HTMLElement) {
    const offsets = new WeakMap<Element, number>();
    const width = (nav: Element) =>
      nav.closest(".app-shell--evidence-focus, .app-shell--sidebar-collapsed") ? 800 : 440;
    // jsdom has no layout. Model the shell width and native clamping while the
    // actual app binding and revealTab own every focus-driven scroll adjustment.
    const clientWidth = vi
      .spyOn(Element.prototype, "clientWidth", "get")
      .mockImplementation(function (this: Element) {
        return root.contains(this) && this.matches("nav.tab-bar") ? width(this) : 0;
      });
    const scrollGet = vi.spyOn(Element.prototype, "scrollLeft", "get").mockImplementation(function (
      this: Element,
    ) {
      return offsets.get(this) ?? 0;
    });
    const scrollSet = vi.spyOn(Element.prototype, "scrollLeft", "set").mockImplementation(function (
      this: Element,
      value: number,
    ) {
      offsets.set(this, Math.max(0, Math.min(value, 600 - width(this))));
    });
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (root.contains(this) && this.matches("nav.tab-bar")) {
        return new DOMRect(0, 0, width(this), 40);
      }
      const nav = this.parentElement;
      if (root.contains(this) && nav?.matches("nav.tab-bar") && this.matches("button[data-tab]")) {
        return new DOMRect([...nav.children].indexOf(this) * 100 - nav.scrollLeft, 0, 100, 40);
      }
      return new DOMRect();
    });
    return () => {
      rect.mockRestore();
      scrollSet.mockRestore();
      scrollGet.mockRestore();
      clientWidth.mockRestore();
    };
  }

  it.each([false, true])(
    "keeps Capture visible when leaving Evidence (sidebar collapsed=%s)",
    async (collapsed) => {
      localStorage.setItem("qa-lab-sidebar-collapsed", collapsed ? "1" : "0");
      const { root, snapshot } = await mountNavigation();
      const restoreGeometry = mockTabGeometry(root);
      try {
        root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!.click();
        const capture = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
        capture.focus();
        expect(capture.parentElement!.clientWidth).toBe(800);
        expect(capture.parentElement!.scrollLeft).toBe(0);
        capture.click();

        const next = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
        const nav = next.parentElement!;
        expect(document.activeElement).toBe(next);
        expect(next.classList.contains("active")).toBe(true);
        expect(nav.clientWidth).toBe(collapsed ? 800 : 440);
        expect(nav.scrollLeft).toBe(collapsed ? 0 : 160);
        expect(next.getBoundingClientRect().right).toBeLessThanOrEqual(nav.clientWidth);

        await pollWithMessage(snapshot);
        const refreshed = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
        expect(document.activeElement).toBe(refreshed);
        expect(refreshed.parentElement!.scrollLeft).toBe(nav.scrollLeft);
      } finally {
        restoreGeometry();
      }
    },
  );

  it("clamps the saved offset before restoring focus when Evidence widens the tab bar", async () => {
    const { root } = await mountNavigation();
    const restoreGeometry = mockTabGeometry(root);
    try {
      const capture = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
      capture.focus();
      expect(capture.parentElement!.scrollLeft).toBe(160);
      const evidence = root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!;
      evidence.focus();
      evidence.click();

      const next = root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!;
      expect(document.activeElement).toBe(next);
      expect(next.classList.contains("active")).toBe(true);
      expect(next.parentElement!.clientWidth).toBe(800);
      expect(next.parentElement!.scrollLeft).toBe(0);
      expect(next.getBoundingClientRect().left).toBeGreaterThanOrEqual(0);
    } finally {
      restoreGeometry();
    }
  });

  it.each([false, true])(
    "keeps non-tab focus during width changes (outside focus=%s)",
    async (outside) => {
      const { root } = await mountNavigation();
      const restoreGeometry = mockTabGeometry(root);
      try {
        const button = document.createElement("button");
        document.body.append(button);
        if (outside) {
          button.focus();
        }
        const focused = document.activeElement;
        root.querySelector<HTMLElement>("nav.tab-bar")!.scrollLeft = 120;
        root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!.click();
        expect(root.querySelector<HTMLElement>("nav.tab-bar")!.scrollLeft).toBe(0);
        expect(document.activeElement).toBe(focused);
        root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!.click();
        expect(root.querySelector<HTMLElement>("nav.tab-bar")!.scrollLeft).toBe(0);
        expect(document.activeElement).toBe(focused);
      } finally {
        restoreGeometry();
      }
    },
  );

  it.each(["chat", "results", "evidence", "report", "events", "capture"])(
    "retains the focused %s tab and offset when polling replaces the navigation",
    async (tab) => {
      const { root, snapshot } = await mountNavigation();
      const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
      const button = nav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
      button.focus();
      nav.scrollLeft = 137.25;
      const focusReveals: number[] = [];
      root.addEventListener(
        "focus",
        (event) => {
          if (event.target instanceof HTMLButtonElement && event.target.dataset.tab === tab) {
            const focusedNav = event.target.parentElement!;
            focusedNav.scrollLeft = 243.75;
            focusReveals.push(focusedNav.scrollLeft);
          }
        },
        true,
      );
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      try {
        await pollWithMessage(snapshot);

        const nextNav = root.querySelector<HTMLElement>("nav.tab-bar")!;
        const nextButton = nextNav.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)!;
        expect(nextNav).not.toBe(nav);
        expect(button.isConnected).toBe(false);
        expect(document.activeElement).toBe(nextButton);
        expect(nextNav.scrollLeft).toBe(137.25);
        expect(focusReveals).toEqual([243.75]);
        expect(focus).toHaveBeenCalledTimes(1);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(nextNav.querySelector<HTMLElement>(".active")?.dataset.tab).toBe("chat");
        expect(root.querySelector("#chat-messages")?.textContent).toContain("new polling message");
        expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(2);

        nextButton.blur();
        nextButton.focus();
        expect(document.activeElement).toBe(nextButton);
        expect(nextNav.scrollLeft).toBe(243.75);
        expect(focusReveals).toEqual([243.75, 243.75]);
      } finally {
        focus.mockRestore();
      }
    },
  );

  it("keeps the same navigation nodes and focus when polling is unchanged", async () => {
    const { root } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    const button = nav.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
    button.focus();
    nav.scrollLeft = 91.5;

    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector("nav.tab-bar")).toBe(nav);
    expect(document.activeElement).toBe(button);
    expect(nav.scrollLeft).toBe(91.5);
    expect(httpMock.getJson.mock.calls.filter(([url]) => url === "/api/state")).toHaveLength(2);
  });

  it("retains a focused tab through activation and the next changed poll", async () => {
    const { root, snapshot } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    const button = nav.querySelector<HTMLButtonElement>('[data-tab="events"]')!;
    button.focus();
    nav.scrollLeft = 83.5;
    button.click();

    const activated = root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="events"]')!;
    expect(button.isConnected).toBe(false);
    expect(document.activeElement).toBe(activated);
    expect(activated.classList.contains("active")).toBe(true);
    expect(activated.parentElement!.scrollLeft).toBe(83.5);

    await pollWithMessage(snapshot);

    const refreshed = root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="events"]')!;
    expect(activated.isConnected).toBe(false);
    expect(document.activeElement).toBe(refreshed);
    expect(refreshed.classList.contains("active")).toBe(true);
    expect(refreshed.parentElement!.scrollLeft).toBe(83.5);
    expect(root.querySelector(".events-scroll")?.textContent).toContain("new polling message");
  });

  it("retains horizontal navigation scroll without moving focus into it", async () => {
    const { root, snapshot } = await mountNavigation();
    const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    nav.scrollLeft = 64.5;
    expect(document.activeElement).toBe(document.body);

    await pollWithMessage(snapshot);

    const nextNav = root.querySelector<HTMLElement>("nav.tab-bar")!;
    expect(nextNav).not.toBe(nav);
    expect(nextNav.scrollLeft).toBe(64.5);
    expect(document.activeElement).toBe(document.body);
  });

  it.each(["#conversation-id", "#composer-text"])(
    "preserves %s focus and draft while retaining navigation scroll",
    async (selector) => {
      const { root, snapshot } = await mountNavigation();
      const nav = root.querySelector<HTMLElement>("nav.tab-bar")!;
      const input = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      input.value = "unfinished draft";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      nav.scrollLeft = 48.5;

      await pollWithMessage(snapshot);

      const nextInput = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)!;
      expect(input.isConnected).toBe(false);
      expect(document.activeElement).toBe(nextInput);
      expect(nextInput.value).toBe("unfinished draft");
      expect(root.querySelector<HTMLElement>("nav.tab-bar")!.scrollLeft).toBe(48.5);
    },
  );

  it("does not steal outside focus for a matching tab identity or control id", async () => {
    const { root, snapshot } = await mountNavigation();
    root.querySelector<HTMLButtonElement>('nav.tab-bar [data-tab="report"]')!.focus();
    const outsideNav = document.createElement("nav");
    outsideNav.className = "tab-bar";
    const outside = document.createElement("button");
    outside.dataset.tab = "report";
    outside.id = "composer-text";
    outsideNav.append(outside);
    document.body.append(outsideNav);
    outside.focus();
    const nav = root.querySelector("nav.tab-bar");

    await pollWithMessage(snapshot);

    expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
    expect(document.activeElement).toBe(outside);
  });

  it("defers changed polling while a select is focused and renders after it blurs", async () => {
    const { root, snapshot } = await mountNavigation();
    const select = root.querySelector<HTMLSelectElement>("#conversation-kind")!;
    const nav = root.querySelector("nav.tab-bar");
    select.focus();

    await pollWithMessage(snapshot);

    expect(root.querySelector("nav.tab-bar")).toBe(nav);
    expect(document.activeElement).toBe(select);
    expect(root.querySelector("#chat-messages")?.textContent).not.toContain("new polling message");
    select.blur();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector("nav.tab-bar")).not.toBe(nav);
    expect(select.isConnected).toBe(false);
    expect(root.querySelector("#chat-messages")?.textContent).toContain("new polling message");
    expect(document.activeElement).toBe(document.body);
  });
});

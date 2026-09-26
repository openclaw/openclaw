/* @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import {
  createBootstrap,
  httpMock,
  mountRunner,
  setupAppBrowserTests,
} from "./app.browser.test-support.js";
import type { EvidenceEnvelope, OutcomesEnvelope, RunnerSelection } from "./ui-types.js";

function createRunnerSelection(): RunnerSelection {
  return {
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
  };
}

async function mountRunningControlUi(controlUiUrl: string | null) {
  const selection: RunnerSelection = createRunnerSelection();
  const root = await mountRunner(selection);
  const getJson = httpMock.getJson.getMockImplementation()!;
  const bootstrap = createBootstrap(selection);
  bootstrap.runner.status = "running";
  bootstrap.runner.startedAt = "2026-09-19T00:00:00.000Z";
  const outcomes: OutcomesEnvelope = {
    run: {
      kind: "suite",
      status: "running",
      startedAt: bootstrap.runner.startedAt,
      scenarios: [{ id: "dm-chat-baseline", name: "DM baseline", status: "pending" }],
      counts: { total: 1, pending: 1, running: 0, passed: 0, failed: 0, skipped: 0 },
    },
  };
  const setControlUiUrl = (value: string | null) => {
    bootstrap.controlUiUrl = value;
    bootstrap.controlUiEmbeddedUrl = value;
  };
  setControlUiUrl(controlUiUrl);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/bootstrap") {
      return structuredClone(bootstrap);
    }
    if (url === "/api/outcomes") {
      return structuredClone(outcomes);
    }
    return getJson(url);
  });
  // The server publishes running/pending before the Gateway link, then waits for transport.
  // Consume that fingerprint first so it cannot hide a later link-only update.
  await vi.advanceTimersByTimeAsync(1_000);
  return { root, setControlUiUrl };
}

function selectValue(root: HTMLElement, selector: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(selector);
  if (!select) {
    throw new Error(`missing select ${selector}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

setupAppBrowserTests();

describe("QA Lab runner browser interactions", () => {
  it.each([
    {
      name: "fractional right clipping",
      navLeft: 0,
      clientLeft: 0,
      clientWidth: 320,
      scrollLeft: 0,
      tabLeft: 286.5625,
      expected: 35.59375,
    },
    {
      name: "left clipping",
      navLeft: 0,
      clientLeft: 0,
      clientWidth: 320,
      scrollLeft: 90,
      tabLeft: -20.5,
      expected: 69.5,
    },
    {
      name: "fully outside right",
      navLeft: 0,
      clientLeft: 0,
      clientWidth: 320,
      scrollLeft: 0,
      tabLeft: 500,
      expected: 249.03125,
    },
    {
      name: "fully outside left",
      navLeft: 0,
      clientLeft: 0,
      clientWidth: 320,
      scrollLeft: 400,
      tabLeft: -100,
      expected: 300,
    },
    {
      name: "offset bordered scrollport",
      navLeft: 200.25,
      clientLeft: 2,
      clientWidth: 320,
      scrollLeft: 50,
      tabLeft: 500.75,
      expected: 97.53125,
    },
    {
      name: "already visible after scrolling",
      navLeft: 0,
      clientLeft: 0,
      clientWidth: 320,
      scrollLeft: 50,
      tabLeft: 100,
      expected: 50,
    },
    {
      name: "desktop without overflow",
      navLeft: 360,
      clientLeft: 0,
      clientWidth: 1080,
      scrollLeft: 0,
      tabLeft: 686.5625,
      expected: 0,
    },
  ])("reveals the focused tab within its own scrollport: $name", async (geometry) => {
    const root = await mountRunner(createRunnerSelection());
    const tab = root.querySelector<HTMLButtonElement>('[data-tab="report"]')!;
    const nav = tab.parentElement!;
    const main = nav.parentElement!;
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(
      new DOMRect(geometry.navLeft, 81.5, geometry.clientWidth + 2 * geometry.clientLeft, 50.5),
    );
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(
      new DOMRect(geometry.tabLeft, 89.5, 69.03125, 33.5),
    );
    let scrollLeft = geometry.scrollLeft;
    const setScrollLeft = vi.fn((value: number) => {
      scrollLeft = value;
    });
    Object.defineProperties(nav, {
      clientLeft: { configurable: true, value: geometry.clientLeft },
      clientWidth: { configurable: true, value: geometry.clientWidth },
      scrollLeft: { configurable: true, get: () => scrollLeft, set: setScrollLeft },
    });
    nav.scrollTop = 17;
    main.scrollLeft = 11;
    main.scrollTop = 23;
    root.scrollLeft = 7;
    root.scrollTop = 13;

    tab.focus();

    expect(document.activeElement).toBe(tab);
    expect(nav.scrollLeft).toBe(geometry.expected);
    if (geometry.expected === geometry.scrollLeft) {
      expect(setScrollLeft).not.toHaveBeenCalled();
    } else {
      expect(setScrollLeft).toHaveBeenCalledExactlyOnceWith(geometry.expected);
    }
    expect(nav.scrollTop).toBe(17);
    expect([main.scrollLeft, main.scrollTop, root.scrollLeft, root.scrollTop]).toEqual([
      11, 23, 7, 13,
    ]);
    expect(root.querySelector<HTMLElement>(".tab-btn.active")?.dataset.tab).toBe("chat");
    expect(root.querySelector('[data-tab="report"]')).toBe(tab);
  });

  it("binds tab focus reveal again after navigation replaces the tab bar", async () => {
    const root = await mountRunner(createRunnerSelection());
    const oldNav = root.querySelector(".tab-bar");
    root.querySelector<HTMLButtonElement>('[data-tab="report"]')!.click();
    const tab = root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!;
    const nav = tab.parentElement!;
    expect(nav).not.toBe(oldNav);
    vi.spyOn(nav, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 320, 50));
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(new DOMRect(480, 0, 88, 32));
    Object.defineProperty(nav, "clientWidth", { configurable: true, value: 320 });

    tab.focus();

    expect(document.activeElement).toBe(tab);
    expect(nav.scrollLeft).toBe(248);
    expect(root.querySelector<HTMLElement>(".tab-btn.active")?.dataset.tab).toBe("report");
    tab.click();
    expect(root.querySelector<HTMLElement>(".tab-btn.active")?.dataset.tab).toBe("capture");
  });

  it.each([false, true])(
    "preserves the manual sidebar preference across Evidence navigation (collapsed=%s)",
    async (collapsed) => {
      localStorage.setItem("qa-lab-sidebar-collapsed", collapsed ? "1" : "0");
      const root = await mountRunner(createRunnerSelection());
      expect(
        [...root.querySelectorAll<HTMLElement>("[data-tab]")].map((node) => node.dataset.tab),
      ).toEqual(["chat", "results", "evidence", "report", "events", "capture"]);

      root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!.click();
      expect(root.querySelector(".app-shell--evidence-focus")).not.toBeNull();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(collapsed);
      expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "1" : "0");

      root.querySelector<HTMLButtonElement>('[data-tab="capture"]')!.click();
      expect(root.querySelector(".app-shell--evidence-focus")).toBeNull();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(collapsed);

      root.querySelector<HTMLButtonElement>('[data-action="toggle-sidebar"]')!.click();
      expect(localStorage.getItem("qa-lab-sidebar-collapsed")).toBe(collapsed ? "0" : "1");
      root.querySelector<HTMLButtonElement>('[data-tab="evidence"]')!.click();
      root.querySelector<HTMLButtonElement>('[data-tab="chat"]')!.click();
      expect(Boolean(root.querySelector(".app-shell--sidebar-collapsed"))).toBe(!collapsed);
    },
  );

  it("keeps header actions and the Control UI link alongside long errors", async () => {
    const selection: RunnerSelection = createRunnerSelection();
    const controlUiUrl = "https://control.example.test/";
    const root = await mountRunner(selection, undefined, null, controlUiUrl);
    expect(root.querySelector<HTMLAnchorElement>(".header-link")?.href).toBe(controlUiUrl);

    const message = `Request failed: <missing> ${"error-context".repeat(16)}`;
    httpMock.getJson.mockRejectedValueOnce(new Error(message));
    root.querySelector<HTMLButtonElement>('[data-action="refresh"]')!.click();
    await vi.waitFor(() =>
      expect(root.querySelector(".header-status .badge-fail")?.textContent).toContain(message),
    );
    expect(root.querySelector(".header-title")?.textContent).toBe("QA Lab");
    expect(root.querySelector<HTMLAnchorElement>(".header-link")?.href).toBe(controlUiUrl);
    expect(
      [...root.querySelectorAll<HTMLElement>(".header-right [data-action]")].map(
        (node) => node.dataset.action,
      ),
    ).toEqual(["toggle-sidebar", "refresh", "reset", "toggle-theme"]);
  });

  it.each([
    { action: "attaches", before: null, after: "http://127.0.0.1:43124/control-ui/" },
    {
      action: "changes",
      before: "http://127.0.0.1:43124/control-ui/",
      after: "http://127.0.0.1:43124/control-ui/?panel=chat",
    },
    { action: "removes", before: "http://127.0.0.1:43124/control-ui/", after: null },
  ])("$action the Control UI link when only its bootstrap URLs change", async (testCase) => {
    const { root, setControlUiUrl } = await mountRunningControlUi(testCase.before);
    const header = root.querySelector(".header")!;
    const readHref = () => root.querySelector(".header-link")?.getAttribute("href") ?? null;
    expect(readHref()).toBe(testCase.before);

    setControlUiUrl(testCase.after);
    expect(readHref()).toBe(testCase.before);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(readHref()).toBe(testCase.after);
    expect(header.isConnected).toBe(false);
  });

  it.each([null, "http://127.0.0.1:43124/control-ui/"])(
    "keeps the same header for an unchanged poll with Control UI URL %s",
    async (controlUiUrl) => {
      const { root } = await mountRunningControlUi(controlUiUrl);
      const header = root.querySelector(".header");
      const link = root.querySelector(".header-link");

      await vi.advanceTimersByTimeAsync(1_000);

      expect(root.querySelector(".header")).toBe(header);
      expect(root.querySelector(".header-link")).toBe(link);
    },
  );

  it("defers link updates while a select is focused, then renders the latest URL", async () => {
    const { root, setControlUiUrl } = await mountRunningControlUi(null);
    const header = root.querySelector(".header");
    const select = root.querySelector<HTMLSelectElement>("#conversation-kind")!;
    expect(select.isConnected).toBe(true);
    expect(select.disabled).toBe(false);
    select.focus();
    expect(document.activeElement).toBe(select);

    for (const url of [
      "http://127.0.0.1:43124/control-ui/",
      "http://127.0.0.1:43124/control-ui/?panel=chat",
    ]) {
      setControlUiUrl(url);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(root.querySelector(".header")).toBe(header);
      expect(root.querySelector(".header-link")).toBeNull();
      expect(document.activeElement).toBe(select);
    }

    select.blur();
    expect(document.activeElement).not.toBe(select);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(root.querySelector(".header-link")?.getAttribute("href")).toBe(
      "http://127.0.0.1:43124/control-ui/?panel=chat",
    );
    expect(select.isConnected).toBe(false);
  });

  it("selects duplicate evidence labels independently before and after filtering", async () => {
    const originalUrl = window.location.href;
    window.history.replaceState(null, "", "/evidence?path=fixture/qa-evidence.json");
    try {
      const evidence: EvidenceEnvelope["evidence"] = {
        counts: { pass: 1, fail: 0, blocked: 0, skipped: 0 },
        entries: (["fail", "pass"] as const).map((status, index) => ({
          artifacts: [
            {
              exists: true,
              error: null,
              href: `/api/evidence/artifact?entryIndex=${index}&artifactIndex=0`,
              kind: "log",
              mediaKind: "text",
              path: `attempt-${index}.log`,
              preview: `observed attempt ${index}`,
              source: "synthetic-runner",
            },
          ],
          coverage: [],
          failureReason: null,
          key: String(index),
          effective: index === 1,
          id: "same-label",
          kind: "script-test",
          sourcePath: null,
          status,
          title: `Attempt ${index}`,
        })),
        evidenceMode: "full",
        evidencePath: "fixture/qa-evidence.json",
        generatedAt: "2026-06-17T12:00:00.000Z",
        producerContext: null,
        profile: null,
        schemaVersion: 3,
      };
      const root = await mountRunner(createRunnerSelection(), undefined, evidence);
      expect(root.querySelector(".evidence-inspector")?.textContent).toContain(
        "observed attempt 0",
      );
      root.querySelector<HTMLButtonElement>('[data-evidence-entry-key="1"]')!.click();
      expect(root.querySelector(".evidence-inspector")?.textContent).toContain(
        "observed attempt 1",
      );
      expect(root.querySelector(".evidence-inspector")?.textContent).not.toContain(
        "observed attempt 0",
      );
      expect(root.querySelectorAll(".evidence-entry-card.selected")).toHaveLength(1);
      selectValue(root, "#evidence-status-filter", "fail");
      expect(root.querySelector(".evidence-inspector")?.textContent).toContain(
        "observed attempt 0",
      );
      expect(root.querySelector(".evidence-inspector")?.textContent).toContain("not counted");
      selectValue(root, "#evidence-status-filter", "all");
      root.querySelector<HTMLButtonElement>('[data-evidence-entry-key="1"]')!.click();
      expect(root.querySelector(".evidence-inspector")?.textContent).toContain(
        "observed attempt 1",
      );
      expect(evidence.entries.map((entry) => entry.id)).toEqual(["same-label", "same-label"]);
    } finally {
      window.history.replaceState(null, "", originalUrl);
    }
  });

  it("labels every execution configuration select", async () => {
    const root = await mountRunner(createRunnerSelection());

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    const selects = [...root.querySelectorAll<HTMLSelectElement>(".config-field select")];

    expect(selects).toHaveLength(9);
    expect(selects.map((select) => select.labels?.[0]?.textContent?.trim())).toEqual([
      "Profile",
      "Provider lane",
      "Channel driver",
      "Execution channel",
      "Evidence mode",
      "Runtime pair",
      "Runtime-pair lane",
      "Primary model",
      "Alternate model",
    ]);
  });

  it("sends group conversation messages from the interactive chat composer", async () => {
    const root = await mountRunner(createRunnerSelection(), {
      conversations: [{ accountId: "default", id: "qa-room", kind: "channel" }],
      cursor: 0,
      events: [],
      messages: [],
      threads: [
        {
          accountId: "default",
          conversationId: "qa-room",
          createdAt: 0,
          createdBy: "qa-operator",
          id: "owned-thread",
          title: "Owned thread",
        },
      ],
    });
    httpMock.postJson.mockResolvedValue({ message: { id: "group-message" } });

    root.querySelector<HTMLButtonElement>("[data-thread-select='owned-thread']")?.click();
    selectValue(root, "#conversation-kind", "group");
    const conversationInput = root.querySelector<HTMLInputElement>("#conversation-id");
    if (!conversationInput) {
      throw new Error("missing group conversation input");
    }
    conversationInput.value = "qa-group";
    conversationInput.dispatchEvent(new Event("input", { bubbles: true }));
    const composer = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (!composer) {
      throw new Error("missing group message composer");
    }
    composer.value = "hello group";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-action='send']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/inbound/message",
      expect.objectContaining({
        accountId: "default",
        conversation: { id: "qa-group", kind: "group", title: "qa-group" },
        text: "hello group",
      }),
    );
    const submittedPayload = httpMock.postJson.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(submittedPayload).not.toHaveProperty("threadId");
  });

  it("keeps scenario rows from collapsing inside the scrolling list", async () => {
    const root = await mountRunner(createRunnerSelection());

    const scroll = root.querySelector<HTMLElement>(".scenario-scroll");
    const row = root.querySelector<HTMLElement>(".scenario-item");
    expect(scroll).not.toBeNull();
    expect(row).not.toBeNull();
    expect(getComputedStyle(scroll!).overflowY).toBe("auto");
    expect(getComputedStyle(row!).flexShrink).toBe("0");
  });

  it("submits live-provider and Crabline selections with non-flow scenarios", async () => {
    const root = await mountRunner({
      alternateModel: "openai/gpt-5.6-luna",
      channel: null,
      channelDriver: "crabline",
      evidenceMode: "full",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "live-frontier",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-action='select-all-scenarios']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    );
  });

  it("changes to real channels without changing the mock provider lane", async () => {
    const root = await mountRunner(createRunnerSelection());

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    expect(
      Array.from(
        root.querySelectorAll<HTMLSelectElement>("#execution-channel option"),
        (option) => option.value,
      ),
    ).toEqual(["", "buzz", "matrix", "telegram"]);
    selectValue(root, "#channel-driver", "live");
    selectValue(root, "#execution-channel", "telegram");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "live",
        channel: "telegram",
        providerMode: "mock-openai",
      }),
    );
  });

  it("submits profile, evidence, runtime-pair, lane, and channel controls", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channel: null,
      channelDriver: "live",
      evidenceMode: "full",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      profile: "all",
      providerMode: "mock-openai",
      runtimePair: null,
      runtimePairLane: null,
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    selectValue(root, "#execution-channel", "telegram");
    selectValue(root, "#evidence-mode", "slim");
    selectValue(root, "#runtime-pair", "openclaw,codex");
    selectValue(root, "#runtime-pair-lane", "core");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        channel: "telegram",
        channelDriver: "crabline",
        evidenceMode: "slim",
        runtimePair: ["openclaw", "codex"],
        runtimePairLane: "core",
        scenarioIds: null,
      }),
    );
  });

  it("renders server-resolved exclusions and errors from a rejected launch", async () => {
    const root = await mountRunner(createRunnerSelection());
    httpMock.postJson.mockRejectedValueOnce(
      new httpMock.QaLabHttpError("selection rejected", 400, {
        plan: {
          errors: ["Explicit QA scenario selection is not runnable."],
          exclusions: [
            {
              executionKind: "flow",
              reasons: ["channel=telegram"],
              scenarioId: "dm-chat-baseline",
            },
          ],
          executionKinds: [],
          explicitScenarioSelection: true,
          profile: "all",
          selectedScenarios: [],
          status: "invalid",
        },
      }),
    );

    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(root.textContent).toContain("1 excluded"));
    expect(root.textContent).toContain("Explicit QA scenario selection is not runnable");

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#evidence-mode", "slim");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='run']")?.click();
    expect(root.textContent).not.toContain("Explicit QA scenario selection is not runnable");
    expect(root.textContent).not.toContain("Resolved plan:");
  });

  it("starts a dirty profile override without reusing the previous resolved plan", async () => {
    const root = await mountRunner(createRunnerSelection());

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#run-profile", "smoke-ci");
    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='scenarios']")?.click();
    root
      .querySelector<HTMLInputElement>("[data-scenario-toggle-id='browser-talk-start-stop']")
      ?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        profile: "smoke-ci",
        scenarioIds: ["browser-talk-start-stop"],
      }),
    );
  });

  it("disables launch when an explicit override becomes empty", async () => {
    const root = await mountRunner(createRunnerSelection());

    root.querySelector<HTMLInputElement>("[data-scenario-toggle-id='dm-chat-baseline']")?.click();
    const runButton = root.querySelector<HTMLButtonElement>("[data-action='run-suite']");
    expect(runButton?.disabled).toBe(true);
    expect(runButton?.textContent).toContain("Run 0 scenarios");
    runButton?.click();
    expect(httpMock.postJson).not.toHaveBeenCalled();
  });
});

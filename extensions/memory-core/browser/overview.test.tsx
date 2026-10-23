/* @vitest-environment jsdom */

import { render } from "@solidjs/web";
import type {
  ControlUiComponentHandle,
  ControlUiSettingsContext,
  ControlUiSettingsComponents,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  containerForTest,
  contextForTest,
  deferred,
  disposers,
  disposeTestViews,
  expectText,
  findButton,
  mountSettingsView,
  snapshot,
  type MutableSnapshot,
  waitForSolid,
} from "./memory.test-support.ts";
afterEach(disposeTestViews);
function createTestComponents(): ControlUiSettingsComponents {
  function mount<P>(
    container: HTMLElement,
    initial: P,
    draw: (props: P) => HTMLElement,
  ): ControlUiComponentHandle<P> {
    const update = (props: P) => container.replaceChildren(draw(props));
    update(initial);
    return { update, dispose: () => container.replaceChildren() };
  }
  const text = (tag: string, ...content: (string | number | HTMLElement | undefined)[]) => {
    const element = document.createElement(tag);
    for (const child of content) {
      if (child !== undefined) {
        element.append(typeof child === "number" ? String(child) : child);
      }
    }
    return element;
  };
  return {
    mountSection: (container, props) =>
      mount(container, props, (next) => text("section", text("h3", next.title), next.content)),
    mountRow: (container, props) =>
      mount(container, props, (next) => {
        const row = text("div", next.title, next.description, next.control);
        row.className = "settings-row";
        return row;
      }),
    mountStatus: (container, props) => mount(container, props, (next) => text("span", next.label)),
    mountValue: (container, props) => mount(container, props, (next) => text("span", next.value)),
    mountNavigation: (container, props) =>
      mount(container, props, (next) => {
        const button = text("button", next.title);
        button.addEventListener("click", next.onClick);
        return button;
      }),
    mountLobster: (container, props) =>
      mount(container, props, (next) => {
        const pet = text("span");
        pet.dataset.testLobster = "";
        pet.dataset.reading = String(next.reading === true);
        return pet;
      }),
  };
}

import { settingsViews } from "./index.tsx";
import { createMemoryOverview, type MemoryOverviewStatus } from "./overview.tsx";

type MemoryOverviewProps = Parameters<ReturnType<typeof createMemoryOverview>>[0];
const overviewContext = (props = snapshot()) =>
  contextForTest(props, { components: createTestComponents() });

type OverviewPayload = DoctorMemoryStatusPayload & {
  dreaming: NonNullable<DoctorMemoryStatusPayload["dreaming"]>;
};
function fixturePayload(): OverviewPayload {
  const phaseBase = {
    enabled: true,
    cron: "0 3 * * *",
    managedCronPresent: true,
    nextRunAtMs: Date.now() + 60_000,
  };
  return {
    agentId: "main",
    provider: "local",
    embedding: { ok: true, checked: true },
    embeddingRuntime: {
      engine: "llama.cpp",
      state: "ready",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embedding-model" },
      endpoints: { metrics: "ready" },
    },
    dreaming: {
      enabled: true,
      timezone: "Europe/Vienna",
      verboseLogging: false,
      storageMode: "inline",
      separateReports: false,
      shortTermCount: 4,
      recallSignalCount: 8,
      dailySignalCount: 3,
      groundedSignalCount: 2,
      totalSignalCount: 13,
      phaseSignalCount: 7,
      lightPhaseHitCount: 5,
      remPhaseHitCount: 2,
      promotedTotal: 21,
      promotedToday: 3,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      phases: {
        light: { ...phaseBase, lookbackDays: 7, limit: 20 },
        deep: {
          ...phaseBase,
          limit: 10,
          minScore: 0.7,
          minRecallCount: 3,
          minUniqueQueries: 2,
          recencyHalfLifeDays: 14,
        },
        rem: { ...phaseBase, lookbackDays: 30, limit: 10, minPatternStrength: 0.6 },
      },
    },
  };
}

function renderOverview(
  status: MemoryOverviewStatus,
  engineSelection = snapshot().engine,
  overrides: Partial<MemoryOverviewProps> = {},
) {
  const container = containerForTest();
  const context = overviewContext(snapshot({ engine: engineSelection }));
  const MemoryOverview = createMemoryOverview(context, () => context.props);
  const props = {
    agentId: "main",
    engineSelection,
    engineDisabled: false,
    status,
    probingEmbeddings: false,
    onRefresh: vi.fn(),
    onProbeEmbeddings: vi.fn(),
    onNavigate: vi.fn(),
    ...overrides,
  };
  disposers.push(render(() => <MemoryOverview {...props} />, container));
  flush();
  return container;
}

describe("MemoryOverview", () => {
  it("renders the awake reading hero and status cards from one payload", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expectText(container, [
      "Memory is awake",
      "memory-core · hybrid search",
      "Sleep schedule",
      "Europe/Vienna",
      "Promoted today",
      "21",
      "b10357 (689e227db)",
      "metrics=ready",
    ]);
    expect(container.querySelector('[data-reading="true"]')).not.toBeNull();
  });

  it("renders a grumpy error hero with retry and no book", () => {
    const container = renderOverview({ kind: "error", message: "gateway request failed" });

    expectText(container, ["Memory needs attention", "gateway request failed", "Retry"]);
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("renders the dimmed sleeping hero when the engine is off", () => {
    const container = renderOverview(
      { kind: "idle" },
      { kind: "off", id: null, availability: "enabled" },
    );

    expectText(container, ["Memory is hibernating", "Open Settings"]);
    expect(container.querySelector(".memory-overview__hero--sleeping")).not.toBeNull();
    expect(container.querySelector("[data-test-lobster]")).not.toBeNull();
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("hibernates a disabled pinned engine and points to Settings", () => {
    const container = renderOverview(
      { kind: "ready", payload: fixturePayload() },
      { kind: "pinned", id: "memory-core", availability: "enabled" },
      { engineDisabled: true },
    );

    expectText(
      container,
      ["Memory is hibernating", "selected memory engine is disabled", "Open Settings"],
      ["Engine health", "Sleep schedule"],
    );
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it.each([false, true])("reports phase eligibility with dream cycle enabled=%s", (enabled) => {
    const payload = fixturePayload();
    payload.dreaming.enabled = enabled;
    payload.dreaming.phases.light.managedCronPresent = !enabled;
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      (enabled ? /Light phase/ : /Light phase|Deep phase|REM phase/).test(row.textContent ?? ""),
    );
    expect(phaseRows).toHaveLength(enabled ? 1 : 3);
    for (const row of phaseRows) {
      expectText(
        row,
        [enabled ? "Not scheduled" : "Disabled"],
        enabled ? ["Enabled", "next "] : ["next "],
      );
    }
  });

  it("offers an inline embedding test before readiness has been checked", () => {
    const payload = fixturePayload();
    payload.embedding = {
      ok: false,
      checked: false,
      error: "run `openclaw memory status --deep` to probe",
    };
    const onProbeEmbeddings = vi.fn();
    const container = renderOverview({ kind: "ready", payload }, undefined, {
      onProbeEmbeddings,
    });

    expect(container.textContent).toContain("Embedding readiness has not been checked yet.");
    expect(container.textContent).not.toContain("openclaw memory status --deep");
    const testButton = findButton(container, /^Test$/);
    expect(testButton?.disabled).toBe(false);
    testButton?.click();
    expect(onProbeEmbeddings).toHaveBeenCalledOnce();
  });

  it.each([
    { searchRuntimeRegistered: false, error: "memory plugin unavailable", neutral: true },
    { searchRuntimeRegistered: true, error: "search manager failed", neutral: false },
  ])("distinguishes absent search support from $error", ({ neutral, ...diagnostic }) => {
    const container = renderOverview({
      kind: "ready",
      payload: {
        agentId: "main",
        searchRuntimeRegistered: diagnostic.searchRuntimeRegistered,
        embedding: { ok: false, error: diagnostic.error },
      },
    });

    expect(container.querySelector(".memory-overview__hero h2")?.textContent).toBe(
      neutral ? "Host memory search is unavailable" : "Memory needs attention",
    );
    expect(container.textContent?.includes("Engine health")).toBe(!neutral);
    expect(container.textContent?.includes(diagnostic.error)).toBe(!neutral);
  });

  it("opens the Memories tab from the overview shortcut", () => {
    const onNavigate = vi.fn();
    const container = renderOverview({ kind: "idle" }, undefined, { onNavigate });

    findButton(container, /Search memories/)?.click();
    expect(onNavigate).toHaveBeenCalledWith("memories");
  });
});

it("clears a roster error in the mounted plugin without issuing a Doctor request", async () => {
  const context = overviewContext(snapshot({ agentId: null, agentsError: "roster failed" }));
  const { request } = context;
  const { container, update } = mountSettingsView(settingsViews[0]!, context);
  await waitForSolid(() => expect(container.textContent).toContain("roster failed"));
  update({ agentsError: null, agentsLoading: true });
  await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
  update({ agentsError: null, agentsLoading: false });
  await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
  expect(request).not.toHaveBeenCalled();
});

describe("Memory overview request presentation", () => {
  function fixture(props = snapshot()) {
    const abort = new AbortController();
    const pending: ReturnType<typeof deferred<DoctorMemoryStatusPayload>>[] = [];
    const request = vi.fn((_method: string, _params?: unknown) => {
      const read = deferred<DoctorMemoryStatusPayload>();
      pending.push(read);
      return read.promise;
    });
    const context = contextForTest(props, {
      signal: abort.signal,
      components: createTestComponents(),
      // SAFETY: This view only reads doctor.memory.status; each deferred has that response type.
      request: request as ControlUiSettingsContext["request"],
    });
    const container = containerForTest();
    const handle = settingsViews[0]!.mount(container, context);
    disposers.push(() => handle.dispose());
    flush();
    let current = props;
    return {
      abort,
      container,
      context,
      pending,
      request,
      dispose: handle.dispose,
      update(patch: Partial<MutableSnapshot>) {
        current = { ...current, ...patch };
        handle.update(current);
        flush();
      },
    };
  }
  const payload = (id: string): DoctorMemoryStatusPayload => ({
    agentId: id,
    embedding: { ok: false, checked: false },
    embeddingRuntime: { state: "ready", engine: "llama.cpp", buildInfo: id },
  });
  async function settle(f: ReturnType<typeof fixture>, index: number, id: string) {
    f.pending[index]!.resolve(payload(id));
    await waitForSolid(() => expect(f.container.textContent).toContain(id));
  }

  it("deduplicates ordinary reads and retains cards while an explicit embedding test runs", async () => {
    const f = fixture();
    f.update({ locale: "en" });
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", { agentId: "main" });
    await settle(f, 0, "accepted-engine");
    const button = findButton(f.container, /^Test$/)!;
    button.click();
    await waitForSolid(() => expect(button.disabled).toBe(true));
    expect(f.container.textContent).toContain("accepted-engine");
    expect(findButton(f.container, /Testing/)).toBe(button);
    expect(f.request).toHaveBeenLastCalledWith("doctor.memory.status", {
      agentId: "main",
      probe: true,
    });
    await settle(f, 1, "probed-engine");
    expect(findButton(f.container, /^Test$/)?.disabled).toBe(false);
  });

  it("shows read failures and replaces the error with loading during retry", async () => {
    const f = fixture();
    f.pending[0]!.reject(new Error("Doctor temporarily unavailable"));
    await waitForSolid(() =>
      expect(f.container.textContent).toContain("Doctor temporarily unavailable"),
    );
    findButton(f.container, /^Retry$/)?.click();
    await waitForSolid(() =>
      expectText(f.container, ["Waking memory"], ["Doctor temporarily unavailable"]),
    );
    await settle(f, 1, "retried-engine");
  });

  it.each<[string, Partial<MutableSnapshot>]>([
    ["agent", { agentId: "writer" }],
    ["engine", { engine: { kind: "pinned", id: "custom-memory", availability: "unknown" } }],
    ["epoch", { connectionEpoch: 2 }],
    ["route", { routeIntent: "overview?agent=writer" }],
  ])("retires a held probe when %s authority changes", async (_kind, patch) => {
    const f = fixture();
    await settle(f, 0, "accepted-engine");
    findButton(f.container, /^Test$/)?.click();
    f.update(patch);
    expect(f.request).toHaveBeenCalledTimes(3);
    f.pending[1]!.resolve(payload("retired-engine"));
    await f.pending[1]!.promise;
    await waitForSolid(() =>
      expectText(f.container, ["Waking memory"], ["retired-engine", "accepted-engine", "Testing"]),
    );
    await settle(f, 2, "fresh-engine");
  });

  it.each<[string, Partial<MutableSnapshot>]>([
    ["off", { engine: { kind: "off", id: null, availability: "unknown" } }],
    ["offline", { connected: false }],
    ["no-agent", { agentId: null }],
  ])("retires pending reads when %s without another Doctor request", async (kind, patch) => {
    const f = fixture();
    f.update(patch);
    f.pending[0]!.resolve(payload("retired-engine"));
    await f.pending[0]!.promise;
    flush();
    expect(f.request).toHaveBeenCalledTimes(1);
    expectText(
      f.container,
      [
        kind === "off"
          ? "Memory is hibernating"
          : kind === "offline"
            ? "gateway is offline"
            : "Waking memory",
      ],
      ["retired-engine", "Testing"],
    );
  });

  it("retains disabled-engine reads and makes disposed controls harmless", async () => {
    const disabled = fixture(
      snapshot({ engine: { ...snapshot().engine, availability: "disabled" } }),
    );
    expect(disabled.request).toHaveBeenCalledTimes(1);
    disabled.dispose();
    const f = fixture();
    expect(f.request).toHaveBeenCalledTimes(1);
    const refresh = findButton(f.container, /^Refresh status$/)!;
    f.abort.abort();
    f.dispose();
    f.pending[0]!.reject(new Error("retired failure"));
    await f.pending[0]!.promise.catch(() => undefined);
    refresh.click();
    expect(f.request).toHaveBeenCalledTimes(1);
  });
});

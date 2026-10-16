/* @vitest-environment jsdom */

import { render } from "@solidjs/web";
import type {
  ControlUiComponentHandle,
  ControlUiSettingsComponents,
  ControlUiSettingsContext,
  ControlUiSettingsSnapshot,
  DoctorMemoryStatusPayload,
} from "openclaw/plugin-sdk/control-ui";
import { flush, untrack } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
});
const waitForSolid = (assertion: () => void) =>
  vi.waitFor(() => {
    flush();
    assertion();
  });
const formatRelativeTimestamp = String;
function mountSolid(view: Parameters<typeof render>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = render(view, container);
  disposers.push(() => {
    dispose();
    container.remove();
  });
  return { container };
}
// SDK component doubles expose content and callbacks, not host styling or artwork.
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
        pet.dataset.sleeping = String(next.sleeping === true);
        return pet;
      }),
  };
}

import type { MemoryOverviewStatus } from "./controller.ts";
import { settingsViews } from "./index.tsx";
import { createMemoryOverview } from "./overview.tsx";

type ViewProps = Parameters<ReturnType<typeof createMemoryOverview>>[0];
type MemoryOverviewProps = Omit<ViewProps, "engineSelection"> & {
  engineSelection: { kind: "default" | "pinned" | "off"; pluginId?: string };
};
function MemoryOverview(props: MemoryOverviewProps) {
  const signal = new AbortController().signal;
  const snapshot: ControlUiSettingsSnapshot = untrack(() => ({
    agentId: props.agentId,
    agentsLoading: false,
    agentsError: null,
    engine: {
      kind: props.engineSelection.kind,
      id: props.engineSelection.pluginId ?? null,
      availability: "enabled",
    },
    connected: true,
    connectionEpoch: 1,
    routeIntent: "overview",
    locale: "en",
  }));
  const context: ControlUiSettingsContext = {
    props: snapshot,
    signal,
    components: createTestComponents(),
    formatRelativeTimestamp,
    request: vi.fn(),
    navigate: vi.fn(),
    refreshAgents: vi.fn(),
    formatError: String,
  };
  const View = createMemoryOverview(context, () => snapshot);
  return <View {...props} engineSelection={snapshot.engine} />;
}

function fixturePayload(): DoctorMemoryStatusPayload {
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
      backend: "metal",
      buildInfo: "b10357 (689e227db)",
      model: { id: "embeddinggemma-300m-qat-q8_0" },
      endpoints: {
        health: "ready",
        models: "ready",
        props: "ready",
        metrics: "ready",
      },
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
  engineSelection: MemoryOverviewProps["engineSelection"] = {
    kind: "default",
    pluginId: "memory-core",
  },
  overrides: Partial<MemoryOverviewProps> = {},
) {
  const { container } = mountSolid(() => (
    <MemoryOverview
      {...{
        agentId: "main",
        engineSelection,
        engineDisabled: false,
        status,
        probingEmbeddings: false,
        onRefresh: vi.fn(),
        onProbeEmbeddings: vi.fn(),
        onNavigate: vi.fn(),
        ...overrides,
      }}
    />
  ));
  flush();
  return container;
}

describe("MemoryOverview", () => {
  it("renders the awake reading hero and status cards from one payload", () => {
    const container = renderOverview({ kind: "ready", payload: fixturePayload() });

    expect(container.textContent).toContain("Memory is awake");
    expect(container.textContent).toContain("memory-core · hybrid search");
    expect(container.querySelector('[data-reading="true"]')).not.toBeNull();
    expect(container.textContent).toContain("Sleep schedule");
    expect(container.textContent).toContain("Europe/Vienna");
    expect(container.textContent).toContain("Promoted today");
    expect(container.textContent).toContain("21");
    expect(container.textContent).toContain("b10357 (689e227db)");
    expect(container.textContent).toContain("metrics=ready");
  });

  it("renders a grumpy error hero with retry and no book", () => {
    const container = renderOverview({ kind: "error", message: "gateway request failed" });

    expect(container.textContent).toContain("Memory needs attention");
    expect(container.textContent).toContain("gateway request failed");
    expect(container.textContent).toContain("Retry");
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("renders the dimmed sleeping hero when the engine is off", () => {
    const container = renderOverview({ kind: "idle" }, { kind: "off" });

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector(".memory-overview__hero--sleeping")).not.toBeNull();
    expect(container.querySelector("[data-test-lobster]")).not.toBeNull();
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
  });

  it("hibernates a disabled pinned engine and points to Settings", () => {
    const container = renderOverview(
      { kind: "ready", payload: fixturePayload() },
      { kind: "pinned", pluginId: "memory-core" },
      { engineDisabled: true },
    );

    expect(container.textContent).toContain("Memory is hibernating");
    expect(container.textContent).toContain("selected memory engine is disabled");
    expect(container.textContent).toContain("Open Settings");
    expect(container.querySelector('[data-reading="true"]')).toBeNull();
    expect(container.textContent).not.toContain("Engine health");
    expect(container.textContent).not.toContain("Sleep schedule");
  });

  it("reports every phase disabled when the global dream cycle is off", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.enabled = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const phaseRows = [...container.querySelectorAll(".settings-row")].filter((row) =>
      /Light phase|Deep phase|REM phase/.test(row.textContent ?? ""),
    );

    expect(phaseRows).toHaveLength(3);
    expect(phaseRows.every((row) => row.textContent?.includes("Disabled"))).toBe(true);
    expect(phaseRows.every((row) => !row.textContent?.includes("next "))).toBe(true);
  });

  it("reports an enabled phase without its managed cron as not scheduled", () => {
    const payload = fixturePayload();
    if (payload.dreaming) {
      payload.dreaming.phases.light.managedCronPresent = false;
    }
    const container = renderOverview({ kind: "ready", payload });
    const lightRow = [...container.querySelectorAll(".settings-row")].find((row) =>
      row.textContent?.includes("Light phase"),
    );

    expect(lightRow?.textContent).toContain("Not scheduled");
    expect(lightRow?.textContent).not.toContain("Enabled");
    expect(lightRow?.textContent).not.toContain("next ");
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
    const testButton = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Test",
    );
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
    const container = renderOverview({ kind: "ready", payload: fixturePayload() }, undefined, {
      onNavigate,
    });

    const shortcut = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("Search memories"),
    );
    shortcut?.click();
    expect(onNavigate).toHaveBeenCalledWith("memories");
  });
});

it("clears a roster error in the mounted plugin without issuing a Doctor request", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const signal = new AbortController().signal;
  const props: ControlUiSettingsSnapshot = {
    agentId: null,
    agentsLoading: false,
    agentsError: "roster failed",
    engine: { kind: "default", id: "memory-core", availability: "enabled" },
    connected: true,
    connectionEpoch: 1,
    routeIntent: "overview",
    locale: "en",
  };
  const request = vi.fn();
  const context: ControlUiSettingsContext = {
    signal,
    props,
    components: createTestComponents(),
    request,
    navigate: vi.fn(),
    refreshAgents: vi.fn(),
    formatError: String,
    formatRelativeTimestamp,
  };
  const view = settingsViews[0]!.mount(container, context);
  try {
    await waitForSolid(() => expect(container.textContent).toContain("roster failed"));
    view.update({ ...props, agentsError: null, agentsLoading: true });
    await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
    view.update({ ...props, agentsError: null });
    await waitForSolid(() => expect(container.textContent).not.toContain("roster failed"));
    expect(request).not.toHaveBeenCalled();
  } finally {
    view.dispose();
    container.remove();
  }
});

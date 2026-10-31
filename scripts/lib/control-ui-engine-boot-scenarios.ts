import type { Page } from "playwright";
import type { UiSettings } from "../../ui/src/app/settings-contract.ts";
import type { ColdLoadRpcRecord } from "../../ui/src/test-helpers/control-ui-cold-load-probe-init.ts";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";
import { createStreamingReplyProbeInitScript } from "./control-ui-streaming-reply.ts";

const sessionKey = "agent:main:interaction-a";
const activePane = ".chat-pane-cache__pane--active";
const composerSelector = `${activePane} .agent-chat__composer-combobox textarea`;

export type EngineScenario = Omit<InteractionScenario, "run"> & {
  /** Some actions (such as creating a split pane) are desktop-only product controls. */
  viewports?: readonly ("desktop" | "mobile")[];
  /** A fresh context stays unnavigated until the measured action starts. */
  navigation?: "measured" | "reload";
  /** Append to the mock Gateway's init script, preserving WebSocket wrapper order. */
  initScript?: string;
  settings?: Partial<UiSettings>;
  /** Opt-in post-GC checkpoints; excluded from latency comparisons. */
  memory?: boolean;
  run: (
    page: Page,
    gateway: MockGatewayControls,
    checkpoint?: (label: string) => Promise<void>,
  ) => Promise<void | InteractionEvidence>;
};

export function createEngineTranscript(messages: number) {
  return Array.from({ length: messages }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `Transcript 0 message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
    timestamp: 1_800_000_000_000 + index * 1_000,
    __openclaw: { id: `interaction-0-${index}`, seq: index + 1 },
  }));
}

/** Browser-local sampling excludes the driver's polling delay from boot readiness. */
function installEngineBootReadiness() {
  const milestones = { transcriptMs: 0, composerMs: 0, readyMs: 0 };
  Reflect.set(window, "__engineBootReadiness", milestones);
  const sample = () => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const input = pane?.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );
    const rows = pane?.querySelectorAll(".chat-virtual-row .chat-text") ?? [];
    if (
      !milestones.transcriptMs &&
      Reflect.get(pane ?? {}, "transcriptReady") === true &&
      [...rows].some((row) => row.checkVisibility() && row.textContent?.trim())
    ) {
      milestones.transcriptMs = performance.now();
    }
    if (!milestones.composerMs && input && !input.disabled && input.checkVisibility()) {
      milestones.composerMs = performance.now();
    }
    if (milestones.transcriptMs && milestones.composerMs) {
      milestones.readyMs = Math.max(milestones.transcriptMs, milestones.composerMs);
    } else {
      requestAnimationFrame(sample);
    }
  };
  requestAnimationFrame(sample);
}

export function engineProbeInitScript(streaming = false, gatewayLatencyMs = 0) {
  return `;if (window === window.top && location.protocol !== "about:") {
    ${createColdLoadProbeInitScript({
      ownerProbes: false,
      sidebarCounters: false,
      latencyMs: gatewayLatencyMs,
      frameGapMs: 0,
      events: [],
    })}
    ;(() => { const __name = (fn) => fn; (${installEngineBootReadiness.toString()})(); })();
    ${streaming ? createStreamingReplyProbeInitScript() : ""}
  }`;
}

export async function waitForEngineTranscript(
  page: Page,
  messageCount = 400,
): Promise<InteractionEvidence> {
  await page
    .locator(activePane)
    .getByText(`Transcript 0 message ${messageCount - 1}.`, { exact: false })
    .waitFor({ state: "visible" });
  await page.locator(composerSelector).waitFor({ state: "visible" });
  await page.waitForFunction(() => Reflect.get(window, "__engineBootReadiness")?.readyMs > 0);
  await frames(page);
  const evidence = await page.evaluate(() => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const input = pane?.querySelector<HTMLTextAreaElement>(
      ".agent-chat__composer-combobox textarea",
    );
    const cache: Map<string, { snapshot: { messages: unknown[] } }> | undefined = pane
      ? Reflect.get(pane, "chatMessagesBySession")
      : undefined;
    const key = pane ? Reflect.get(pane, "sessionKey") : undefined;
    const snapshot = cache && [...cache].find(([stored]) => stored.endsWith(`\u0000${key}`));
    const milestones: { transcriptMs: number; composerMs: number; readyMs: number } = Reflect.get(
      window,
      "__engineBootReadiness",
    );
    const phases: InteractionEvidence = {
      paintTimingSupported: PerformanceObserver.supportedEntryTypes.includes("paint"),
      fontsLoadingAtCapture: document.fonts.status === "loading",
    };
    // SAFETY: Navigation and resource entries expose their category-specific timing fields.
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    // SAFETY: The resource entry category contains only PerformanceResourceTiming entries.
    const resources = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    if (navigation) {
      for (const [name, value] of Object.entries({
        documentResponseStartMs: navigation.responseStart,
        documentResponseEndMs: navigation.responseEnd,
        domInteractiveMs: navigation.domInteractive,
        domContentLoadedMs: navigation.domContentLoadedEventEnd,
        documentLoadMs: navigation.loadEventEnd,
      })) {
        if (value > 0) {
          phases[name] = value;
        }
      }
    }
    for (const entry of performance.getEntriesByType("paint")) {
      if (entry.name === "first-paint" || entry.name === "first-contentful-paint") {
        phases[entry.name === "first-paint" ? "firstPaintMs" : "firstContentfulPaintMs"] =
          entry.startTime;
      }
    }
    for (const [kind, extension] of [
      ["js", /\.m?js$/u],
      ["css", /\.css$/u],
      ["font", /\.(?:woff2?|ttf|otf)$/u],
    ] as const) {
      // ResourceTiming exposes completed requests, not in-flight preloads at readiness.
      const completed = resources.filter(
        (entry) =>
          entry.responseEnd <= milestones.readyMs && extension.test(new URL(entry.name).pathname),
      );
      phases[`${kind}RequestsCompletedByReady`] = completed.length;
      if (completed.length) {
        phases[`${kind}LastResponseByReadyMs`] = Math.max(
          ...completed.map((entry) => entry.responseEnd),
        );
        for (const field of ["encodedBodySize", "transferSize"] as const) {
          if (completed.some((entry) => entry[field] > 0)) {
            phases[`${kind}${field === "encodedBodySize" ? "Encoded" : "Transfer"}BytesByReady`] =
              completed.reduce((sum, entry) => sum + entry[field], 0);
          }
        }
      }
    }
    const { rpcs }: { rpcs: ColdLoadRpcRecord[] } = Reflect.get(window, "__coldLoad").read();
    for (const [kind, method] of [
      ["connect", "connect"],
      ["history", "sessions.messages.subscribe"],
    ] as const) {
      const rpc = rpcs.find((entry) => entry.method === method && !entry.abandoned);
      if (rpc) {
        phases[`${kind}RequestMs`] = rpc.requestMs;
        phases[`${kind}ResponseMs`] = rpc.responseMs;
        phases[`${kind}RoundTripMs`] = rpc.ms;
        if (rpc.dispatchMs !== undefined) {
          phases[`${kind}DispatchMs`] = rpc.dispatchMs;
        }
      }
    }
    const approvalReplay = rpcs
      .filter((entry) => entry.method === "sessions.messages.subscribe")
      .at(1);
    if (approvalReplay) {
      phases.approvalReplayRequestMs = approvalReplay.requestMs;
      phases.approvalReplayResponseMs = approvalReplay.responseMs;
    }
    return {
      ...milestones,
      ...phases,
      messages: snapshot?.[1].snapshot.messages.length ?? 0,
      mountedRows: pane?.querySelectorAll(".chat-virtual-row").length ?? 0,
      composerReady: input !== null && input !== undefined && !input.disabled,
      transcriptReady: pane ? Reflect.get(pane, "transcriptReady") === true : false,
      longTasksSupported: PerformanceObserver.supportedEntryTypes.includes("longtask"),
      longAnimationFramesSupported:
        PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"),
    };
  });
  if (evidence.messages !== messageCount || !evidence.composerReady || !evidence.transcriptReady) {
    throw new Error(`Engine boot readiness failed: ${JSON.stringify(evidence)}`);
  }
  return evidence;
}

async function persistTranscript(page: Page) {
  await page.evaluate(async () => {
    const pane = document.querySelector(".chat-pane-cache__pane--active");
    const store:
      | {
          write(key: string, snapshot: { messages: unknown[] }): void;
          flush(): Promise<void>;
        }
      | undefined = pane ? Reflect.get(pane, "sessionSnapshotStore") : undefined;
    const cache: Map<string, { snapshot: { messages: unknown[] } }> | undefined = pane
      ? Reflect.get(pane, "chatMessagesBySession")
      : undefined;
    const key = pane ? Reflect.get(pane, "sessionKey") : undefined;
    const entry = cache && [...cache].find(([stored]) => stored.endsWith(`\u0000${key}`));
    if (!store || !entry) {
      throw new Error("Warm boot requires the active transcript persistence owner");
    }
    store.write(entry[0], { ...entry[1].snapshot });
    await store.flush();
  });
}

export function createEngineBootScenarios(
  baseUrl: string,
  gatewayLatencyMs = 0,
): readonly EngineScenario[] {
  const route = controlUiSessionPath(sessionKey);
  const url = new URL(route, baseUrl).href;
  const bootScript = engineProbeInitScript(false, gatewayLatencyMs);
  return [
    ...(["paste", "typing"] as const).map((input): EngineScenario => ({
      id: `native-input-${input}`,
      route: `/__native-input-${input}`,
      explicitOnly: true,
      diagnostic: "Native search-input automation without application code, not a latency floor.",
      expected: "An empty, unfocused native search input receives the complete automation query.",
      navigation: "measured",
      prepare: async (page) => {
        const controlUrl = new URL(`/__native-input-${input}`, baseUrl).href;
        await page.route(controlUrl, (request) =>
          request.fulfill({
            contentType: "text/html",
            body: `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
<title>Native input control</title>
<input type="search" aria-label="Search automations" style="font-size: 16px">`,
          }),
        );
        await page.goto(controlUrl);
      },
      run: async (page) => {
        const query = "Warm automation 0499";
        const search = page.getByRole("searchbox", { name: "Search automations" });
        if (input === "paste") {
          await search.fill(query);
        } else {
          await search.pressSequentially(query);
        }
        if ((await search.inputValue()) !== query) {
          throw new Error("Native input control lost query text");
        }
        return { inputCharacters: query.length };
      },
    })),
    {
      id: "blank-frame-cadence",
      route: "/__frame-cadence-control",
      explicitOnly: true,
      diagnostic: "Blank-document frame cadence, not application latency.",
      expected: "A visible blank document reports its native animation-frame cadence.",
      navigation: "measured",
      prepare: async (page) => {
        const controlUrl = new URL("/__frame-cadence-control", baseUrl).href;
        await page.route(controlUrl, (request) =>
          request.fulfill({
            contentType: "text/html",
            body: "<!doctype html><title>Frame cadence control</title>",
          }),
        );
        await page.goto(controlUrl);
      },
      run: (page) =>
        page.evaluate(
          () =>
            new Promise<InteractionEvidence>((resolve, reject) => {
              if (document.visibilityState !== "visible") {
                reject(new Error("Blank-document cadence requires a visible document"));
                return;
              }
              const times: number[] = [];
              let frame = 0;
              const timeout = setTimeout(() => {
                cancelAnimationFrame(frame);
                reject(new Error("Blank-document animation frames did not finish within 10 s"));
              }, 10_000);
              const sample = (time: number) => {
                times.push(time);
                if (times.length < 61) {
                  frame = requestAnimationFrame(sample);
                  return;
                }
                clearTimeout(timeout);
                const gaps = times.slice(1).map((value, index) => value - times[index]!);
                gaps.sort((left, right) => left - right);
                resolve({
                  frameSamples: gaps.length,
                  frameGapMedianMs: (gaps[29]! + gaps[30]!) / 2,
                  frameGapP95Ms: gaps[56]!,
                  frameGapMinMs: gaps[0]!,
                  frameGapMaxMs: gaps.at(-1)!,
                  documentVisible: document.visibilityState === "visible",
                });
              };
              frame = requestAnimationFrame(sample);
            }),
        ),
    },
    {
      id: "cold-boot",
      route,
      expected: "A fresh browser context shows the 400-message transcript and enabled composer.",
      navigation: "measured",
      initScript: bootScript,
      prepare: async () => {},
      run: async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return waitForEngineTranscript(page);
      },
    },
    {
      id: "warm-boot",
      navigation: "reload",
      route,
      expected: "A same-context reload restores the persisted transcript and enabled composer.",
      initScript: bootScript,
      prepare: async (page) => {
        await waitForEngineTranscript(page);
        await persistTranscript(page);
      },
      run: async (page) => {
        await page.reload({ waitUntil: "domcontentloaded" });
        return waitForEngineTranscript(page);
      },
    },
    {
      id: "large-transcript-open",
      route,
      expected: "A fresh context loads all 2,000 messages, showing the tail and ready composer.",
      navigation: "measured",
      initScript: bootScript,
      fixtureOverrides: () => ({
        sessionTranscripts: { [sessionKey]: { messages: createEngineTranscript(2_000) } },
      }),
      prepare: async () => {},
      run: async (page) => {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        return waitForEngineTranscript(page, 2_000);
      },
    },
  ];
}

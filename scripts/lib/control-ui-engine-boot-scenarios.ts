import type { Page } from "playwright";
import type { UiSettings } from "../../ui/src/app/settings-contract.ts";
import { createColdLoadProbeInitScript } from "../../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createStreamingReplyProbeInitScript } from "../../ui/src/test-helpers/control-ui-streaming-reply.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const sessionKey = "agent:main:interaction-a";
const activePane = ".chat-pane-cache__pane--active";
const composerSelector = `${activePane} .agent-chat__composer-combobox textarea`;

export type EngineScenario = InteractionScenario & {
  /** A fresh context stays unnavigated until the measured action starts. */
  navigation?: "measured" | "reload";
  /** Append to the mock Gateway's init script, preserving WebSocket wrapper order. */
  initScript?: string;
  settings?: Partial<UiSettings>;
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

export function engineProbeInitScript(streaming = false) {
  return `;if (window === window.top && location.protocol !== "about:") {
    ${createColdLoadProbeInitScript({
      ownerProbes: false,
      sidebarCounters: false,
      latencyMs: 0,
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
    return {
      ...Reflect.get(window, "__engineBootReadiness"),
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

export function createEngineBootScenarios(baseUrl: string): readonly EngineScenario[] {
  const route = controlUiSessionPath(sessionKey);
  const url = new URL(route, baseUrl).href;
  const bootScript = engineProbeInitScript();
  return [
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

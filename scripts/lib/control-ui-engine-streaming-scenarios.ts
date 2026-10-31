import type { Page } from "playwright";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import {
  createEngineTranscript,
  engineProbeInitScript,
  waitForEngineTranscript,
  type EngineScenario,
} from "./control-ui-engine-boot-scenarios.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import { createControlUiStreamingReply } from "./control-ui-streaming-fixture.ts";

const sessionKey = "agent:main:interaction-a";
const secondSessionKey = "agent:main:interaction-b";
const activePane = ".chat-pane-cache__pane--active";
const inputSelector = ".agent-chat__composer-combobox textarea";

function installStreamingWorkCounters() {
  const work = { disclosureChecks: 0, nativeScrollToCalls: 0 };
  Reflect.set(window, "__engineStreamingWork", work);
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the original call receiver.
  Element.prototype.matches = new Proxy(Element.prototype.matches, {
    apply(target, receiver, args) {
      if (String(args[0]).startsWith(":has(details[open]")) {
        work.disclosureChecks++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  // oxlint-disable-next-line typescript/unbound-method -- The Proxy forwards the original call receiver.
  Element.prototype.scrollTo = new Proxy(Element.prototype.scrollTo, {
    apply(target, receiver, args) {
      if (receiver instanceof Element && receiver.classList.contains("chat-thread")) {
        work.nativeScrollToCalls++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
}

function streamScenario(options: {
  id: string;
  messages?: number;
  rate?: number;
  panes?: number;
  content?: "markdown" | "tool-code" | "mixed";
}): EngineScenario {
  const messages = options.messages ?? 400;
  const reply = createControlUiStreamingReply(options.rate ?? 30, options.content);
  const expectedParts = [
    ...(reply.text.match(/^export (?:function|const) .+$/gmu) ?? []),
    ...(reply.text.match(/^## .+$/gmu) ?? []).map((heading) => heading.slice(3)),
  ];
  const finalSuffix = reply.growingTool
    ? "Streaming code complete."
    : "The result is ready for the next checkpoint.";
  const endingCount = reply.text.split(finalSuffix).length;
  const streams = [sessionKey, secondSessionKey].slice(0, options.panes ?? 1).map((key, i) => ({
    sessionKey: key,
    runId: `engine-streaming-run-${i}`,
  }));
  const panes = streams.length === 2 ? "openclaw-chat-pane.chat-split-view__pane" : activePane;
  return {
    id: options.id,
    route: controlUiSessionPath(sessionKey),
    explicitOnly: options.id !== "streaming-645-deltas",
    expected: `${streams.length} pane(s) retain native input, the complete ${reply.deltas.length}-delta reply, and tail follow over ${messages} messages at ${reply.deltasPerSecond} Hz.`,
    initScript: `${engineProbeInitScript(true)};(${installStreamingWorkCounters.toString()})();`,
    fixtureOverrides: (_sandbox, base) => ({
      sessions: base.sessions.map((row): typeof row => {
        const stream = streams.find((candidate) => candidate.sessionKey === row.key);
        return stream
          ? { ...row, hasActiveRun: true, status: "running", activeRunIds: [stream.runId] }
          : row;
      }),
      sessionTranscripts: Object.fromEntries(
        streams.map((stream) => [
          stream.sessionKey,
          {
            messages: createEngineTranscript(messages),
            ...(reply.mixed ? { thinkingLevel: "on" } : {}),
            inFlightRun: {
              runId: stream.runId,
              text: "Preparing synthetic reply.",
              startedAt: 1_800_000_400_000,
            },
          },
        ]),
      ),
    }),
    settings:
      streams.length === 2
        ? {
            chatSplitLayout: {
              activePaneId: "engine-pane-0",
              columnWeights: [0.5, 0.5],
              columns: streams.map(({ sessionKey: key }, index) => ({
                id: `engine-column-${index}`,
                paneWeights: [1],
                panes: [{ id: `engine-pane-${index}`, sessionKey: key }],
              })),
            },
          }
        : reply.mixed
          ? { chatShowThinking: true, chatShowToolCalls: true }
          : undefined,
    prepare: async (page) => {
      if (streams.length === 1) {
        await waitForEngineTranscript(page, messages);
      }
      await page.waitForFunction(
        ({ streams: expectedStreams, selector }) =>
          expectedStreams.every((stream) =>
            Array.from(document.querySelectorAll(selector)).some(
              (pane) =>
                Reflect.get(pane, "sessionKey") === stream.sessionKey &&
                pane.getClientRects().length > 0 &&
                pane.querySelector(".chat-thread") &&
                pane.querySelector("textarea"),
            ),
          ),
        { streams, selector: panes },
      );
      if (reply.growingTool) {
        await page.evaluate(
          (activeStreams) =>
            Reflect.get(window, "__streamingReply").prepare({
              streams: activeStreams,
              growingTool: true,
            }),
          streams,
        );
        for (const pane of await page.locator(panes).all()) {
          const tool = pane
            .locator(".chat-tool-msg-collapse")
            .filter({ hasText: "verify-streaming" })
            .last();
          await tool.locator("button.chat-tool-row[aria-expanded='false']").click();
          await tool.locator(".chat-tool-term__out").waitFor({ state: "visible" });
        }
      }
      await page.locator(panes).first().locator(inputSelector).focus();
    },
    run: async (page) => {
      const composers = page.locator(panes).locator(inputSelector);
      const drafts = await composers.evaluateAll((inputs) =>
        inputs.map((element) => {
          if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Missing streaming composer");
          }
          return element.value;
        }),
      );
      const characters = streams.map(() => 0);
      await page.evaluate(() => {
        Object.assign(Reflect.get(window, "__engineStreamingWork"), {
          disclosureChecks: 0,
          nativeScrollToCalls: 0,
        });
      });
      await page.evaluate((input) => Reflect.get(window, "__streamingReply").start(input), {
        ...reply,
        streams,
        burstSize: reply.mixed ? 5 : 1,
        observeTextVisibility: false,
      });
      const typing = new AbortController();
      const input = (async () => {
        let index = 0;
        while (!typing.signal.aborted) {
          const pane = index++ % streams.length;
          await composers.nth(pane).focus();
          await page.keyboard.press("x");
          characters[pane] = characters[pane]! + 1;
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
        }
      })();
      try {
        if (reply.mixed) {
          await page.waitForFunction(
            (count) => Reflect.get(window, "__streamingReply").read().delivered >= count,
            Math.floor(reply.deltas.length / 3),
          );
          await page
            .locator(`${activePane} .chat-activity-group__summary[aria-expanded='false']`)
            .filter({ hasText: "Raw details" })
            .last()
            .click();
          const imageTool = page.locator(`${activePane} [data-message-id*='mixed-tool-24']`);
          const toolSummary = imageTool.locator(
            ".chat-tool-msg-summary[aria-expanded='false'], .chat-tool-row[aria-expanded='false']",
          );
          if (await toolSummary.count()) {
            await toolSummary.first().click();
          }
          // Disclosure clicks can scroll before their deferred layout commit. Admit
          // a visible off-tail state before the native action resets follow intent.
          await page.locator(`${activePane} .chat-thread`).evaluate((thread) => {
            thread.scrollBy({ top: -thread.clientHeight, behavior: "instant" });
          });
          const latest = page.getByRole("button", { name: "Scroll to latest", exact: true });
          await latest.waitFor({ state: "visible" });
          await latest.click();
          await page.waitForFunction((selector) => {
            const thread = document.querySelector<HTMLElement>(`${selector} .chat-thread`)!;
            return Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) <= 2;
          }, activePane);
          const toggle = page.getByRole("button", { name: "Show more", exact: true }).first();
          await toggle.click();
          await page.waitForFunction(() => {
            const samples = Reflect.get(window, "__streamingReply").sidebarInputs();
            return samples.length === 1 && samples[0].nextFrameMs !== undefined;
          });
        }
        await page.waitForFunction(
          (count) => Reflect.get(window, "__streamingReply").read().delivered === count,
          reply.deltas.length * streams.length,
          { timeout: 120_000, polling: 50 },
        );
        await page.waitForFunction(
          ({ selector, ending }) =>
            Array.from(document.querySelectorAll(selector)).every((pane) =>
              pane
                .querySelector(".chat-bubble.streaming .chat-text")
                ?.textContent?.trimEnd()
                .endsWith(ending),
            ),
          {
            selector: panes,
            ending: finalSuffix,
          },
        );
        await frames(page);
      } finally {
        typing.abort();
        await input;
        await page.evaluate(() => Reflect.get(window, "__streamingReply").stop());
      }
      const result = await page.evaluate(() => {
        const snapshot = Reflect.get(window, "__streamingReply").finish();
        Reflect.set(window, "__engineStreamingResult", snapshot);
        return snapshot;
      });
      const retained = await composers.evaluateAll((inputs) =>
        inputs.map((element) => {
          if (!(element instanceof HTMLTextAreaElement)) {
            throw new Error("Missing streaming composer");
          }
          return element.value;
        }),
      );
      if (
        retained.some(
          (draft, i) => !characters[i] || draft !== drafts[i] + "x".repeat(characters[i]!),
        )
      ) {
        throw new Error("Streaming lost native composer input");
      }
      for (const pane of result.panes) {
        if (
          expectedParts.some((part) => !pane.finalText?.includes(part)) ||
          pane.finalText?.split(finalSuffix).length !== endingCount
        ) {
          throw new Error("Streaming lost completed reply content");
        }
        if (
          !pane.visible ||
          !pane.finalHtml ||
          pane.tailPosition.scrollHeight <= pane.tailPosition.initialScrollHeight ||
          Math.abs(pane.tailPosition.distanceFromBottom) > 2
        ) {
          throw new Error(
            `Streaming failed render/follow assertions: ${JSON.stringify(pane.tailPosition)}`,
          );
        }
        if (
          reply.growingTool &&
          !pane.toolOutput?.includes(`Tool progress ${reply.deltas.length}`)
        ) {
          throw new Error("Streaming lost the expanded tool output");
        }
        if (reply.mixed) {
          const plainText = reply.text
            .replace(/^#{1,6} /gmu, "")
            .replace(/^```[^\n]*\n/gmu, "")
            .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
            .replace(/\*\*([^*]+)\*\*/gu, "$1")
            .replace(/^\| ---.*\n/gmu, "")
            .replace(/[|`\s]/gu, "");
          if (pane.finalMarkdownText?.replace(/\s/gu, "") !== plainText) {
            throw new Error("Mixed streaming lost complete rendered Markdown text");
          }
          if (
            !pane.reasoning?.items.some(
              (item: { text: string }) => item.text === reply.mixed!.reasoning,
            )
          ) {
            throw new Error("Mixed streaming lost reasoning");
          }
          for (let tool = 1; tool <= reply.mixed.toolCount; tool++) {
            if (
              !pane.toolResults.some(
                (entry: { toolCallId: string; output: string; resultReceived: boolean }) =>
                  entry.toolCallId === `mixed-tool-${tool}` &&
                  entry.resultReceived &&
                  entry.output === `Mixed tool result ${tool}.`,
              )
            ) {
              throw new Error(`Mixed streaming lost tool result ${tool}`);
            }
          }
        }
      }
      if (reply.mixed) {
        // Verify offscreen media after timing: following the long reply leaves its earlier
        // attachment above the viewport. Native scroll brings the owning row into view.
        await page.locator(`${activePane} .chat-bubble.streaming`).evaluate((bubble) => {
          const thread = bubble.closest<HTMLElement>(".chat-thread")!;
          thread.scrollTop +=
            bubble.getBoundingClientRect().top -
            thread.getBoundingClientRect().top -
            thread.clientHeight / 2;
        });
        // ActivityGroupBody mounts its messages only after Raw details opens.
        const activity = page
          .locator(`${activePane} .chat-activity-group__summary[aria-expanded='false']`)
          .filter({ hasText: "Raw details" })
          .last();
        if (await activity.count()) {
          await activity.click();
        }
        const imageOwner = page.locator(`${activePane} [data-message-id*='mixed-tool-24']`);
        await imageOwner.scrollIntoViewIfNeeded();
        const toolDisclosure = imageOwner.locator(".chat-tool-msg-summary[aria-expanded='false']");
        if (await toolDisclosure.count()) {
          await toolDisclosure.click();
        }
        const attachment = page.locator(`${activePane} .chat-message-image`).last();
        await attachment.waitFor({ state: "visible" });
        await attachment.scrollIntoViewIfNeeded();
        await attachment.evaluate(async (image) => {
          if (!(image instanceof HTMLImageElement)) {
            throw new Error("Mixed streaming image did not render as a native image");
          }
          await image.decode();
          if (!image.complete || image.naturalWidth !== 64 || image.naturalHeight !== 64) {
            throw new Error("Mixed streaming image did not decode");
          }
        });
      }
      const sum = (key: string) =>
        result.deltas.reduce(
          (total: number, delta: Record<string, number>) => total + delta[key]!,
          0,
        );
      return {
        nativeScrollToCalls: await page.evaluate(
          () => Reflect.get(window, "__engineStreamingWork").nativeScrollToCalls,
        ),
        disclosureChecks: await page.evaluate(
          () => Reflect.get(window, "__engineStreamingWork").disclosureChecks,
        ),
        messages,
        panes: streams.length,
        deltas: result.deltas.length,
        streamElapsedMs: result.elapsedMs,
        parseCalls: sum("parseCalls"),
        parseMs: sum("parseMs"),
        fragmentClones: sum("fragmentClones"),
        geometryReads: sum("geometryReads"),
        resizeDeliveries: result.pipeline.rowResizeDeliveries,
        railObservations: result.pipeline.railObservations,
        paneRenders: result.pipeline.paneRenders,
        longAnimationFramesSupported: await page.evaluate(() =>
          PerformanceObserver.supportedEntryTypes.includes("long-animation-frame"),
        ),
        longAnimationFrames: result.longFrames.length,
        frameGapMedianMs: result.frameGapsMs.median,
        frameGapP95Ms: result.frameGapsMs.p95,
        estimatedDroppedFrames: result.estimatedDroppedFrames,
        inputDelayP95Ms: result.inputDelayMs.p95,
        inputToNextFrameP95Ms: result.inputToNextFrameMs.p95,
        characters: characters.reduce((a, b) => a + b, 0),
        inputPreserved: true,
        tailFollowed: true,
        ...(reply.mixed
          ? {
              toolResults: reply.mixed.toolCount,
              reasoningPreserved: true,
              imageDecoded: true,
              sidebarResponsive:
                result.sidebarInputs.length === 1 && result.sidebarInputs[0].commitMs !== undefined,
              sidebarInputDelayMs: result.sidebarInputs[0].delayMs,
              sidebarCommitMs: result.sidebarInputs[0].commitMs,
              sidebarInputToNextFrameMs: result.sidebarInputs[0].nextFrameMs,
              deliveryTaskMedianMs: result.taskAndMicrotasksMs.median,
              deliveryTaskP95Ms: result.taskAndMicrotasksMs.p95,
              deliveryTaskMaxMs: result.taskAndMicrotasksMs.max,
              eventToNextFrameMedianMs: result.eventToNextFrameMs.median,
              eventToNextFrameP95Ms: result.eventToNextFrameMs.p95,
              eventToNextFrameMaxMs: result.eventToNextFrameMs.max,
              commitToNextFrameMedianMs: result.commitToNextFrameMs.median,
              commitToNextFrameP95Ms: result.commitToNextFrameMs.p95,
              commitToNextFrameMaxMs: result.commitToNextFrameMs.max,
              longTasksSupported: result.longTasks !== null,
              ...(result.longTasks === null
                ? {}
                : {
                    longTasks: result.longTasks.length,
                    longestLongTaskMs: Math.max(
                      0,
                      ...result.longTasks.map((task: { duration: number }) => task.duration),
                    ),
                  }),
            }
          : {}),
      };
    },
  };
}

async function scrollToTop(page: Page) {
  return page.locator(`${activePane} .chat-thread`).evaluate(async (thread) => {
    const initialHeight = thread.scrollHeight;
    const frameTimes: number[] = [];
    let blankFrames = 0;
    let mountedRows = 0;
    // Cover the complete history in two seconds at a nominal 60 Hz.
    for (let step = 1; step <= 120; step++) {
      thread.scrollTop = (initialHeight - thread.clientHeight) * (1 - step / 120);
      await new Promise<void>((resolve) => {
        requestAnimationFrame((at) => {
          frameTimes.push(at);
          resolve();
        });
      });
      const bounds = thread.getBoundingClientRect();
      const rows = Array.from(thread.querySelectorAll<HTMLElement>(".chat-virtual-row"));
      mountedRows = Math.max(mountedRows, rows.length);
      const middle = bounds.top + bounds.height / 2;
      if (
        !rows.some((row) => {
          const rect = row.getBoundingClientRect();
          return (
            rect.top <= middle &&
            rect.bottom >= middle &&
            row.checkVisibility({ contentVisibilityAuto: true }) &&
            Boolean(row.textContent?.trim())
          );
        })
      ) {
        blankFrames++;
      }
    }
    const gaps = frameTimes.slice(1).map((at, i) => at - frameTimes[i]!);
    const sorted = gaps.toSorted((a, b) => a - b);
    return {
      scrollFrames: frameTimes.length,
      blankFrames,
      mountedRows,
      frameGapMedianMs: sorted[Math.floor(sorted.length / 2)]!,
      frameGapP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
      estimatedDroppedFrames: gaps.reduce(
        (sum, gap) => sum + Math.max(0, Math.round(gap / (1000 / 60)) - 1),
        0,
      ),
    };
  });
}

export function createEngineStreamingScenarios(): readonly EngineScenario[] {
  const longScroll: EngineScenario = {
    id: "large-transcript-fast-scroll",
    explicitOnly: true,
    route: controlUiSessionPath(sessionKey),
    expected:
      "Scroll through 2,000 messages, retaining visible rows and reporting frame gaps and blank samples.",
    initScript: engineProbeInitScript(),
    fixtureOverrides: () => ({
      sessionTranscripts: { [sessionKey]: { messages: createEngineTranscript(2_000) } },
    }),
    prepare: async (page) => {
      await waitForEngineTranscript(page, 2_000);
    },
    run: async (page) => {
      const evidence = await scrollToTop(page);
      await page
        .locator(activePane)
        .getByText("Transcript 0 message 0.", { exact: false })
        .waitFor({ state: "visible" });
      return evidence;
    },
  };
  return [
    streamScenario({ id: "streaming-645-deltas" }),
    streamScenario({ id: "streaming-645-deltas-slow", rate: 15 }),
    streamScenario({ id: "streaming-large-transcript", messages: 2_000 }),
    streamScenario({ id: "streaming-two-panes", panes: 2 }),
    streamScenario({ id: "streaming-tool-code", content: "tool-code" }),
    streamScenario({ id: "streaming-mixed-fast", rate: 150, content: "mixed" }),
    longScroll,
    {
      ...longScroll,
      id: "large-transcript-return-bottom",
      expected:
        "The native Scroll to latest action returns to message 1,999 and retires its affordance.",
      prepare: async (page, gateway) => {
        await longScroll.prepare(page, gateway);
        await scrollToTop(page);
        await page.getByRole("button", { name: "Scroll to latest" }).waitFor();
      },
      run: async (page) => {
        await page.getByRole("button", { name: "Scroll to latest" }).click();
        await page
          .locator(activePane)
          .getByText("Transcript 0 message 1999.", { exact: false })
          .waitFor({ state: "visible" });
        await page.waitForFunction((selector) => {
          const thread = document.querySelector<HTMLElement>(`${selector} .chat-thread`)!;
          return Math.abs(thread.scrollHeight - thread.clientHeight - thread.scrollTop) <= 2;
        }, activePane);
        await page.getByRole("button", { name: "Scroll to latest" }).waitFor({ state: "hidden" });
        return { messages: 2_000, tailFollowed: true };
      },
    },
  ];
}

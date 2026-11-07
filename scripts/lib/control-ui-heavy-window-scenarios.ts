import type { Page } from "playwright";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createHeavyContentImageSources } from "./control-ui-heavy-content-images.ts";
import { installHeavyCountProbe, readHeavyCountProbe } from "./control-ui-heavy-count-probe.ts";
import type { InteractionScenario } from "./control-ui-interaction-scenarios.ts";
import { readLongSessionMessageCount } from "./control-ui-long-session-probe.ts";

const sessionKey = "agent:main:interaction-a";
const pane = ".chat-pane-cache__pane--active";
const thread = `${pane} .chat-thread`;
const marker = "Heavy window target";
type HeavyWindowFixture = { id: string; text: string; kind: string };

let nativeImages: string[] | undefined;

type WindowCounts = {
  highlightRequests: number;
  imageLoads: number;
  decodeCalls: number;
};
declare global {
  interface Window {
    heavyWindowCounts: WindowCounts;
  }
}

async function setup(page: Page) {
  await page.addInitScript(() => {
    window.heavyWindowCounts = {
      highlightRequests: 0,
      imageLoads: 0,
      decodeCalls: 0,
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private highlight = false;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.highlight = String(url).includes("markdown-code-highlight");
      }
      override postMessage(
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[],
      ) {
        if (this.highlight) {
          window.heavyWindowCounts.highlightRequests++;
        }
        if (Array.isArray(options)) {
          super.postMessage(message, options);
        } else {
          super.postMessage(message, options);
        }
      }
    };
    document.addEventListener(
      "load",
      (event) => {
        if (event.target instanceof HTMLImageElement && event.target.closest(".chat-thread")) {
          window.heavyWindowCounts.imageLoads++;
        }
      },
      true,
    );
    // oxlint-disable-next-line typescript/unbound-method -- Called below with the original image receiver.
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function () {
      window.heavyWindowCounts.decodeCalls++;
      return decode.call(this);
    };
  });
}

function messages(fixture: HeavyWindowFixture) {
  if (fixture.kind === "native-images") {
    nativeImages ??= createHeavyContentImageSources();
  }
  return Array.from({ length: 2_000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content:
      index === 1
        ? fixture.kind === "native-images"
          ? [
              { type: "text", text: `${marker} ${fixture.id}` },
              ...Array.from({ length: 40 }, (_image, image) => ({
                type: "image",
                url: nativeImages![image],
                alt: `Window image ${image}`,
                width: 1024,
                height: 1024,
              })),
            ]
          : fixture.kind === "tool"
            ? [
                { type: "text", text: `${marker} ${fixture.id}` },
                {
                  type: "toolCall",
                  id: "window-tool",
                  name: "exec",
                  arguments: { input: "synthetic" },
                },
                {
                  type: "toolResult",
                  id: "window-tool",
                  name: "exec",
                  text: JSON.stringify([{ type: "input_text", text: fixture.text }]),
                  __openclaw: {
                    toolOutput: { source: "provider-response", modelInput: "unverified" },
                  },
                },
              ]
            : `${marker} ${fixture.id}\n\n${fixture.text}`
        : `Window transcript message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
    timestamp: 1_800_000_000_000 + index * 1_000,
    __openclaw: { id: `window-${index}`, seq: index + 1 },
  }));
}

async function measureCrossings(page: Page, fixture: HeavyWindowFixture, crossingCount: number) {
  return page.evaluate(
    async ({ selector, kind, id, expected, count }) => {
      const scroller = document.querySelector<HTMLElement>(selector)!;
      const findRow = () =>
        [...scroller.querySelectorAll<HTMLElement>(".chat-virtual-row")].find((row) =>
          kind === "tool"
            ? row.querySelector(".chat-tool-msg-summary") !== null
            : row.textContent?.includes(`Heavy window target ${id}`),
        );
      const frame = () => new Promise(requestAnimationFrame);
      const wait = async (ready: () => boolean, phase = "row") => {
        for (let attempt = 0; attempt < 1_800; attempt++) {
          if (ready()) {
            return;
          }
          await frame();
        }
        const controls = [...scroller.querySelectorAll(".chat-virtual-row")].map((row) => ({
          key: row.getAttribute("data-virtual-row-key"),
          targetMarker: row.textContent?.includes(`Heavy window target ${id}`),
          buttons: [...row.querySelectorAll("button")].map((button) => ({
            class: button.className,
            disabled: button.disabled,
            expanded: button.getAttribute("aria-expanded"),
          })),
          images: [...row.querySelectorAll("img")].map((image) => ({
            loaded: image.complete && image.naturalWidth > 0,
            top: image.getBoundingClientRect().top,
          })),
        }));
        throw new Error(
          `Heavy window crossing did not settle (${phase}): ${JSON.stringify(controls)}`,
        );
      };
      const move = (offset: number) => {
        scroller.scrollTop = offset;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      };
      const results = [];
      for (let index = 0; index < count; index++) {
        const started = performance.now();
        move(0);
        await wait(() => Boolean(findRow()));
        const row = findRow()!;
        let observedHeightChanges = 0;
        // Observe the virtualizer's recorded measurements without adding a layout observer.
        const measurements = new MutationObserver((records) => {
          for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
            const next = records[recordIndex + 1]?.oldValue ?? row.getAttribute("data-row-size");
            if (records[recordIndex]!.oldValue !== next) {
              observedHeightChanges++;
            }
          }
        });
        measurements.observe(row, {
          attributes: true,
          attributeFilter: ["data-row-size"],
          attributeOldValue: true,
        });
        let reopened = false;
        if (kind === "code") {
          await wait(() => Boolean(row.querySelector(".code-block-expand")));
          const expand = row.querySelector<HTMLButtonElement>(".code-block-expand")!;
          reopened = expand.getAttribute("aria-expanded") !== "true";
          if (reopened) {
            expand.click();
          }
          await wait(
            () => row.querySelectorAll("pre code span").length >= (id === "diff" ? 5_030 : 5_000),
          );
          if (row.querySelector("pre code")?.textContent !== expected) {
            throw new Error("Remounted code lost source text");
          }
        } else if (kind === "tool") {
          const group = row.querySelector<HTMLButtonElement>(".chat-activity-group__summary");
          if (group && group.getAttribute("aria-expanded") !== "true") {
            group.click();
          }
          await wait(
            () =>
              Boolean(
                row.querySelector(
                  ".chat-tool-row__toggle:not(:disabled), button.chat-tool-msg-summary:not(:disabled)",
                ),
              ),
            "enabled tool control",
          );
          const toggle = row.querySelector<HTMLButtonElement>(
            ".chat-tool-row__toggle:not(:disabled), button.chat-tool-msg-summary:not(:disabled)",
          )!;
          reopened = toggle.getAttribute("aria-expanded") !== "true";
          if (reopened) {
            toggle.click();
          }
          await wait(
            () =>
              row.querySelector(".chat-tool-card__block-content code")?.textContent === expected,
            "tool preview",
          );
        } else if (kind === "images" || kind === "native-images") {
          await wait(() => {
            const images = [...row.querySelectorAll<HTMLImageElement>("img")];
            return (
              images.length === 40 &&
              images.every((image) => image.complete && image.naturalWidth > 0)
            );
          });
        } else if (kind === "table" && row.querySelectorAll("tbody tr").length !== 300) {
          throw new Error("Remounted table lost rows");
        }
        if (kind === "huge") {
          const source = `Heavy window target ${id}\n\n${expected}`;
          await wait(() => Boolean(row.querySelector(".markdown-plain-text-fallback")));
          const fallback = row.querySelector(".markdown-plain-text-fallback")!;
          const shown =
            (fallback.querySelector(".markdown-plain-text-source") ?? fallback).textContent ?? "";
          if (
            row.querySelector(".chat-bubble")?.getAttribute("data-message-text") !== source ||
            !shown.startsWith(source.slice(0, 140_000)) ||
            shown.length > 142_000
          ) {
            throw new Error("Remounted huge message changed its source or bounded fallback");
          }
        }
        let height = row.getBoundingClientRect().height;
        for (let settled = 0, attempt = 0; settled < 4; attempt++) {
          if (attempt >= 240) {
            throw new Error("Heavy row geometry did not settle in 240 frames");
          }
          await frame();
          const next = row.getBoundingClientRect().height;
          if (next !== height) {
            settled = 0;
          } else {
            settled++;
          }
          height = next;
        }
        measurements.disconnect();
        results.push({
          height,
          observedHeightChanges,
          reopened,
          rows: scroller.querySelectorAll(".chat-virtual-row").length,
          applicationMs: performance.now() - started,
        });
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
        move(scroller.scrollHeight);
        await wait(() => !row.isConnected);
        for (let settle = 0; settle < 4; settle++) {
          await frame();
        }
      }
      return results;
    },
    {
      count: crossingCount,
      selector: thread,
      kind: fixture.kind,
      id: fixture.id,
      expected:
        fixture.kind === "code"
          ? fixture.text.slice(fixture.text.indexOf("\n") + 1, -3)
          : fixture.kind === "tool"
            ? fixture.text.slice(0, 8_000)
            : fixture.text,
    },
  );
}

export function createHeavyWindowScenarios(
  fixtures: readonly HeavyWindowFixture[],
): InteractionScenario[] {
  return fixtures
    .filter(
      ({ id }) =>
        [
          "code",
          "diff",
          "table",
          "terminal-dense",
          "json-nested-dense",
          "images",
          "large-images",
        ].includes(id) || id.startsWith("megabyte-"),
    )
    .flatMap((fixture) => {
      const scenario: InteractionScenario = {
        id: `heavy-window-${fixture.id}`,
        route: controlUiSessionPath(sessionKey),
        resourceOnly: true,
        fixture: { heavyContent: true },
        fixtureOverrides: () => ({
          sessionTranscripts: { [sessionKey]: { messages: messages(fixture) } },
        }),
        expected:
          "A heavy row leaves and re-enters a 2,000-message transcript three times, preserving its complete content and bounded DOM.",
        setup,
        prepare: async (page) => {
          await page.getByText("Window transcript message 1999.", { exact: false }).waitFor();
          await page.locator(thread).hover();
          await page.mouse.wheel(0, -1);
          await measureCrossings(page, fixture, 1);
        },
        run: async (page) => {
          const before = await page.evaluate(() => ({ ...window.heavyWindowCounts }));
          await page.locator(thread).hover();
          await page.mouse.wheel(0, -1);
          const crossings = await measureCrossings(page, fixture, 3);
          const after = await page.evaluate(() => ({ ...window.heavyWindowCounts }));
          const messageCount = await readLongSessionMessageCount(page, sessionKey);
          if (messageCount !== 2_000) {
            throw new Error(`Window crossing changed retained message count: ${messageCount}`);
          }
          return {
            messages: messageCount,
            crossings: crossings.length,
            highlightRequests: after.highlightRequests - before.highlightRequests,
            imageLoads: after.imageLoads - before.imageLoads,
            decodeCalls: after.decodeCalls - before.decodeCalls,
            maxSettledMountedRows: Math.max(...crossings.map((crossing) => crossing.rows)),
            reopenCount: crossings.filter((crossing) => crossing.reopened).length,
            observedHeightChanges: crossings.reduce(
              (sum, crossing) => sum + crossing.observedHeightChanges,
              0,
            ),
            minHeight: Math.min(...crossings.map((crossing) => crossing.height)),
            maxHeight: Math.max(...crossings.map((crossing) => crossing.height)),
            crossing1Ms: crossings[0]!.applicationMs,
            crossing2Ms: crossings[1]!.applicationMs,
            crossing3Ms: crossings[2]!.applicationMs,
          };
        },
      };
      return [
        scenario,
        {
          ...scenario,
          id: `${scenario.id}-counts`,
          diagnostic: "Source-map entry counters modify loaded code; timing is diagnostic only.",
          setup: async (page) => {
            await scenario.setup!(page);
            await installHeavyCountProbe(page, { markdownParserRender: true });
          },
          run: async (page, gateway) => {
            const before = await readHeavyCountProbe(page);
            const result = await scenario.run(page, gateway);
            const after = await readHeavyCountProbe(page);
            if (!after.instrumented.includes("markdownRenders")) {
              throw new Error("Markdown entry count was not instrumented");
            }
            return {
              ...result,
              markdownRenders: after.counts.markdownRenders - before.counts.markdownRenders,
              parserRenders: after.counts.parserRenders - before.counts.parserRenders,
              toolFormats: after.counts.toolFormats - before.counts.toolFormats,
              diffAnalyses: after.counts.diffAnalyses - before.counts.diffAnalyses,
              markdownInstrumented: after.instrumented.includes("markdownRenders"),
              parserInstrumented: after.instrumented.includes("parserRenders"),
              toolInstrumented: after.instrumented.includes("toolFormats"),
              diffInstrumented: after.instrumented.includes("diffAnalyses"),
            };
          },
        },
      ];
    });
}

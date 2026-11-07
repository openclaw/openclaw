import type { Page } from "playwright";
import { mediaTicketPayload } from "../../ui/src/test-helpers/control-ui-attachment-fixtures.ts";
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
  metadataRequests: number;
  imageRequests: number;
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
      metadataRequests: 0,
      imageRequests: 0,
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
      if (this.closest(".chat-thread") || this.src.includes("/__openclaw__/assistant-media")) {
        window.heavyWindowCounts.decodeCalls++;
      }
      return decode.call(this);
    };
  });
}

function messages(fixture: HeavyWindowFixture) {
  return Array.from({ length: 2_000 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content:
      index === 1
        ? fixture.kind === "native-images"
          ? [
              { type: "text", text: `${marker} ${fixture.id}` },
              ...Array.from({ length: 40 }, (_image, image) => ({
                type: "image",
                url: `media://inbound/window-${image}.png`,
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
          row.textContent?.includes(`Heavy window target ${id}`),
        );
      const frame = () => new Promise(requestAnimationFrame);
      const wait = async (ready: () => boolean) => {
        for (let attempt = 0; attempt < 1_800; attempt++) {
          if (ready()) {
            return;
          }
          await frame();
        }
        throw new Error("Heavy window crossing did not settle in 1,800 frames");
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
        let reopened = false;
        if (kind === "code") {
          await wait(() => Boolean(row.querySelector(".code-block-expand")));
          const expand = row.querySelector<HTMLButtonElement>(".code-block-expand")!;
          reopened = expand.getAttribute("aria-expanded") !== "true";
          if (reopened) {
            expand.click();
          }
          await wait(() => row.querySelectorAll("pre code span").length >= 5_000);
          if (row.querySelector("pre code")?.textContent !== expected) {
            throw new Error("Remounted code lost source text");
          }
        } else if (kind === "tool") {
          const group = row.querySelector<HTMLButtonElement>(".chat-activity-group__summary");
          if (group && group.getAttribute("aria-expanded") !== "true") {
            group.click();
          }
          await wait(() =>
            Boolean(row.querySelector(".chat-tool-row__toggle, button.chat-tool-msg-summary")),
          );
          const toggle = row.querySelector<HTMLButtonElement>(
            ".chat-tool-row__toggle, button.chat-tool-msg-summary",
          )!;
          reopened = toggle.getAttribute("aria-expanded") !== "true";
          if (reopened) {
            toggle.click();
          }
          await wait(
            () =>
              row.querySelector(".chat-tool-card__block-content code")?.textContent === expected,
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
          if (
            row.querySelector(".chat-bubble")?.getAttribute("data-message-text") !== source ||
            !row
              .querySelector(".markdown-plain-text-fallback")
              ?.textContent?.startsWith(source.slice(0, 140_000))
          ) {
            throw new Error("Remounted huge message changed its source or bounded fallback");
          }
        }
        let height = row.getBoundingClientRect().height;
        let heightCorrections = 0;
        for (let settled = 0, attempt = 0; settled < 4; attempt++) {
          if (attempt >= 240) {
            throw new Error("Heavy row geometry did not settle in 240 frames");
          }
          await frame();
          const next = row.getBoundingClientRect().height;
          if (next !== height) {
            heightCorrections++;
            settled = 0;
          } else {
            settled++;
          }
          height = next;
        }
        results.push({
          height,
          heightCorrections,
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
        setup: async (page) => {
          await setup(page);
          if (fixture.kind !== "native-images") {
            return;
          }
          nativeImages ??= createHeavyContentImageSources();
          await page.route("**/__openclaw__/assistant-media?**", async (route) => {
            const url = new URL(route.request().url());
            const index = Number(
              /window-(\d+)\.png/u.exec(url.searchParams.get("source") ?? "")?.[1],
            );
            if (!Number.isInteger(index) || index < 0 || index >= 40) {
              throw new Error("Unexpected window image request");
            }
            const metadata = url.searchParams.get("meta") === "1";
            await page.evaluate((meta) => {
              if (meta) {
                window.heavyWindowCounts.metadataRequests++;
              } else {
                window.heavyWindowCounts.imageRequests++;
              }
            }, metadata);
            await route.fulfill(
              metadata
                ? { json: mediaTicketPayload(`window-${index}`) }
                : {
                    contentType: "image/png",
                    body: Buffer.from(nativeImages![index]!.split(",")[1]!, "base64"),
                  },
            );
          });
        },
        prepare: async (page) => {
          await page.getByText("Window transcript message 1999.", { exact: false }).waitFor();
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
            metadataRequests: after.metadataRequests - before.metadataRequests,
            imageRequests: after.imageRequests - before.imageRequests,
            maxMountedRows: Math.max(...crossings.map((crossing) => crossing.rows)),
            reopenCount: crossings.filter((crossing) => crossing.reopened).length,
            heightCorrections: crossings.reduce(
              (sum, crossing) => sum + crossing.heightCorrections,
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

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { projectAgentToolActivity } from "../../src/infra/agent-activity-events.js";
import type { MockGatewayControls } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createHeavyContentImageSources } from "./control-ui-heavy-content-images.ts";
import type {
  InteractionEvidence,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const sessionKey = "agent:main:interaction-a";
const pane = ".chat-pane-cache__pane--active";
const runs = new WeakMap<Page, string>();
let nativeImageSources: string[] | undefined;
type WorkerObservation = {
  starts: number;
  replies: number;
  errors: number;
  terminations: number;
  active: number;
};
declare global {
  interface Window {
    /** Installed before startup in the isolated heavy-content fixture. */
    heavyContentWorkers: WorkerObservation;
    /** Native ClipboardItems retained only by the synthetic page clipboard. */
    heavyContentImageClipboard: ClipboardItem[];
    heavyContentCopiedImage?: Blob;
    heavyContentExpectedInput?: { card: string; sidebar: string };
    heavyContentExpectedNestedInput?: string;
  }
}
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";
const largeInputSource = `${Array.from(
  { length: 5_000 },
  (_, index) => `text("synthetic input ${String(index).padStart(4, "0")}");`,
).join("\n")}\n`;
const denseTerminalSource = Array.from(
  { length: 5_000 },
  (_, index) => `${String(index).padStart(4, "0")} synthetic output abcdef0123456789 line\n`,
).join("");
const denseJsonSource = JSON.stringify({
  results: Array.from({ length: 800 }, (_, index) => ({
    id: index,
    label: `synthetic result ${String(index).padStart(4, "0")}`,
    details: {
      stdout: `first line ${index}: ${"abcdefgh".repeat(8)}\nsecond line ${index}: ${"01234567".repeat(8)}\n`,
      metadata: { ok: true, exitCode: 0 },
    },
  })),
});
const nestedInputRows = Array.from({ length: 5_000 }, (_, index) => ({
  index,
  label: `synthetic row ${String(index).padStart(4, "0")}`,
  value: "x".repeat(32),
}));

/** Sizes intentionally exercise both sides of the existing 40,000-character parse limit. */
const heavyContentFixtures = [
  {
    id: "code",
    text: `\`\`\`ts\n${"let x;\n".repeat(5_000)}\`\`\``,
    code: "let x;\n".repeat(5_000),
    kind: "code",
  },
  {
    id: "auto-code",
    text: `\`\`\`\n${"x+=1;\n".repeat(5_000)}\`\`\``,
    code: "x+=1;\n".repeat(5_000),
    kind: "code",
  },
  {
    id: "unsupported-code",
    text: `\`\`\`sql\n${"-- x\n".repeat(5_000)}\`\`\``,
    kind: "code",
  },
  {
    id: "diff",
    text: `\`\`\`diff\n${Array.from({ length: 10 }, (_, file) => `--- a/f${file}\n+++ b/f${file}\n@@ -1,250 +1,250 @@\n${"-old\n+new\n".repeat(250)}`).join("")}\`\`\``,
    kind: "code",
  },
  {
    id: "oversized-code",
    text: `\`\`\`ts\n${"const item = { value: 1 };\n".repeat(5_000)}\`\`\``,
    kind: "fallback",
  },
  {
    id: "table",
    text: `|${Array.from({ length: 12 }, (_, i) => `C${i}`).join("|")}|\n|${"---|".repeat(12)}\n${Array.from({ length: 300 }, (_, row) => `|${Array.from({ length: 12 }, (_cell, col) => `${row}-${col}`).join("|")}|`).join("\n")}`,
    kind: "table",
  },
  { id: "tool-diff", text: "@@\n" + "-old\n+new\n".repeat(2_500), kind: "tool" },
  { id: "tool-diff-error", text: "@@\n" + "-old\n+new\n".repeat(2_500), kind: "tool" },
  { id: "terminal", text: "ok\n".repeat(5_000), kind: "tool" },
  { id: "terminal-dense", text: denseTerminalSource, kind: "tool" },
  { id: "json-nested-dense", text: denseJsonSource, kind: "tool" },
  {
    id: "large-input",
    text: "ok\n",
    inputArgs: { input: largeInputSource },
    kind: "tool",
  },
  {
    id: "nested-input-large",
    text: "ok\n",
    inputArgs: { payload: { rows: nestedInputRows } },
    toolName: "synthetic_nested_args",
    kind: "tool",
  },
  {
    id: "nested-input-small",
    text: "ok\n",
    inputArgs: { payload: { rows: nestedInputRows.slice(0, 25) } },
    toolName: "synthetic_nested_args",
    kind: "tool",
  },
  {
    id: "json",
    text: JSON.stringify(Array.from({ length: 5_000 }, (_, i) => i)),
    kind: "tool",
  },
  {
    id: "json-format",
    text: JSON.stringify(Array.from({ length: 1_900 }, (_, i) => i)),
    kind: "tool",
  },
  {
    id: "images",
    text: Array.from(
      { length: 40 },
      (_, i) => `![Synthetic image ${i}](data:image/png;base64,${png})`,
    ).join("\n\n"),
    kind: "images",
  },
  {
    id: "large-images",
    text: "Forty distinct 1-megapixel synthetic images.",
    kind: "native-images",
  },
] as const;
type Fixture = (typeof heavyContentFixtures)[number];

function rawToolOutput(fixture: Fixture) {
  if (fixture.id === "tool-diff-error") {
    return "Patch context did not match";
  }
  return fixture.id.startsWith("terminal") ||
    fixture.id === "large-input" ||
    fixture.id.startsWith("json")
    ? JSON.stringify([{ type: "input_text", text: fixture.text }])
    : fixture.text;
}

function isDenseTool(fixture: Fixture) {
  return fixture.id === "terminal-dense" || fixture.id === "json-nested-dense";
}

async function denseToolPreview(page: Page, fixture: Fixture): Promise<InteractionEvidence> {
  if (!isDenseTool(fixture)) {
    return {};
  }
  const preview = await page
    .locator(`${pane} .chat-tool-card__block-content code`)
    .first()
    .textContent();
  if (preview !== fixture.text.slice(0, 8_000)) {
    throw new Error("Dense tool preview did not preserve the existing exact 8,000-character cap");
  }
  return { sourceChars: fixture.text.length, previewChars: preview.length, previewCap: 8_000 };
}

async function assertToolOutputLoaded(page: Page) {
  const output = page.locator('.chat-tool-output[aria-busy="false"]');
  await output.waitFor();
  // CopyButton owns a nested hidden status region; only direct notices describe loading failure.
  if (await output.locator(':scope > p[role="status"], :scope > p[role="alert"]').count()) {
    throw new Error("Tool output did not load its complete message");
  }
}

async function denseToolLoad(
  page: Page,
  gateway: MockGatewayControls,
  fixture: Fixture,
): Promise<InteractionEvidence> {
  if (!isDenseTool(fixture)) {
    return {};
  }
  const request = await gateway.waitForRequest("chat.message.get", {
    match: { sessionKey, messageId: "heavy-result", maxChars: 2_000_000 },
  });
  if (!isRecord(request.params) || request.params.maxChars !== 2_000_000) {
    throw new Error("Dense tool output did not use the existing full-message read cap");
  }
  await assertToolOutputLoaded(page);
  const text = await page.locator(".chat-tool-output__text").textContent();
  if (text !== fixture.text) {
    throw new Error("Dense tool full-message read changed the complete displayed output");
  }
  return {
    sourceChars: fixture.text.length,
    rawSourceChars: rawToolOutput(fixture).length,
    outputChars: text.length,
    fullMessageReadCap: request.params.maxChars,
    fullMessageReads: (await gateway.getRequests("chat.message.get")).length,
  };
}

async function frames(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function workerObservation(page: Page) {
  return page.evaluate(() => {
    // SAFETY: The heavy-content init script owns this page-local observation.
    return {
      ...window.heavyContentWorkers,
    };
  });
}

function codeSource(fixture: Fixture) {
  return fixture.text.slice(fixture.text.indexOf("\n") + 1, -3);
}

async function settleCode(page: Page, fixture: Fixture, full = false) {
  const code = page.locator(`${pane} .chat-bubble`).last().locator("pre code");
  if (fixture.id === "auto-code" || fixture.id === "unsupported-code") {
    // A no-op reply has no visible syntax marker, so observe the worker's real completion.
    await page.waitForLoadState("networkidle");
    await frames(page);
    if ((await code.getAttribute("data-code-highlight")) !== null) {
      await page.waitForFunction(() => {
        // SAFETY: Installed by this fixture before application startup.
        const workers = window.heavyContentWorkers;
        return workers.starts > 0 && workers.active === 0;
      });
    }
  } else {
    const selector = fixture.id === "code" ? ".hljs-keyword" : "span";
    const minimum = full ? (fixture.id === "code" ? 5_000 : 5_030) : 7;
    await page.waitForFunction(
      ({ codeSelector, tokenMinimum, rootSelector }) => {
        const block = [...document.querySelectorAll(`${rootSelector} .chat-bubble`)].at(-1);
        return (
          (block?.querySelector("pre code")?.querySelectorAll(codeSelector).length ?? 0) >=
          tokenMinimum
        );
      },
      { codeSelector: selector, tokenMinimum: minimum, rootSelector: pane },
    );
  }
  if ((await code.textContent()) !== codeSource(fixture)) {
    throw new Error("Syntax decoration changed the complete source text");
  }
  const observed = await workerObservation(page);
  if (observed.errors) {
    throw new Error("The highlighting worker reported an error");
  }
  if (observed.starts > 0) {
    await page.waitForFunction(() => {
      // SAFETY: Installed by this fixture before application startup.
      return window.heavyContentWorkers.active === 0;
    });
  }
}

async function prepare(page: Page, gateway: MockGatewayControls) {
  const input = page.locator(`${pane} .agent-chat__composer-combobox textarea`);
  await input.fill("Render the synthetic heavy-content fixture.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const request = await gateway.waitForRequest("chat.send");
  const runId = isRecord(request.params) ? request.params.idempotencyKey : undefined;
  if (typeof runId !== "string") {
    throw new Error("The synthetic chat.send request did not include its run ID");
  }
  runs.set(page, runId);
}

async function deliver(
  page: Page,
  gateway: MockGatewayControls,
  fixture: Fixture,
  stream: boolean,
  readiness: "raw" | "preview" = "preview",
) {
  const runId = runs.get(page)!;
  if (fixture.kind === "native-images") {
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId,
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: fixture.text },
          ...nativeImageSources!.map((url, index) => ({
            type: "image",
            url,
            alt: `Synthetic large image ${index + 1}`,
            width: 1_024,
            height: 1_024,
          })),
        ],
        timestamp: Date.now(),
      },
    });
    await page.waitForFunction((rootSelector) => {
      const images = document.querySelectorAll<HTMLImageElement>(
        `${rootSelector} .chat-message-image`,
      );
      return (
        images.length === 40 &&
        [...images].every(
          (image) =>
            image.complete && image.naturalWidth === 1_024 && image.naturalHeight === 1_024,
        )
      );
    }, pane);
    await frames(page);
    return;
  }
  if (fixture.kind === "tool") {
    const isPatch = fixture.id.startsWith("tool-diff");
    const isError = fixture.id === "tool-diff-error";
    const name = "toolName" in fixture ? fixture.toolName : isPatch ? "apply_patch" : "exec";
    const args =
      "inputArgs" in fixture
        ? fixture.inputArgs
        : isPatch
          ? { changes: [{ path: "synthetic.ts", kind: { type: "update" }, diff: fixture.text }] }
          : { input: "text(await tools.exec_command({cmd: 'synthetic-fixture'}));" };
    await gateway.emitGatewayEvent("agent", {
      sessionKey,
      runId,
      seq: 1,
      stream: "item",
      ts: Date.now(),
      data: projectAgentToolActivity({ phase: "start", toolCallId: "heavy-output", name, args }),
    });
    const output = rawToolOutput(fixture);
    const chunks = stream ? 20 : 1;
    for (let index = 1; index <= chunks; index++) {
      await gateway.emitGatewayEvent("agent", {
        sessionKey,
        runId,
        seq: index + 1,
        stream: "item",
        ts: Date.now(),
        data: projectAgentToolActivity({
          phase: index === chunks ? "result" : "update",
          toolCallId: "heavy-output",
          name,
          args,
          ...(isError ? { isError } : {}),
          result: {
            content: [
              {
                type: "text",
                text: output.slice(0, Math.ceil((output.length * index) / chunks)),
              },
            ],
          },
        }),
      });
      if (stream) {
        await frames(page);
      }
    }
    const message = {
      role: "assistant",
      content: [
        { type: "toolCall", id: "heavy-output", name, arguments: args },
        {
          type: "toolResult",
          id: "heavy-output",
          name,
          text: output,
          isError,
          ...(isPatch
            ? {}
            : {
                __openclaw: {
                  toolOutput: { source: "provider-response", modelInput: "unverified" },
                },
              }),
        },
      ],
      timestamp: Date.now(),
      __openclaw: { id: "heavy-result", seq: 2, runId, runTerminal: true },
    };
    if (isDenseTool(fixture) || fixture.id === "large-input") {
      await gateway.setMethodResponse("chat.message.get", { ok: true, message });
    }
    await gateway.emitGatewayEvent("session.message", {
      sessionKey,
      runId,
      message,
      messageId: "heavy-result",
      messageSeq: 2,
    });
    await gateway.emitGatewayEvent("chat", { sessionKey, runId, state: "final", message });
    await page
      .locator(`${pane} .chat-activity-group__summary, ${pane} .chat-tool-msg-summary`)
      .first()
      .waitFor();
    return;
  }
  if (stream) {
    for (let index = 1; index <= 20; index++) {
      const start = Math.ceil((fixture.text.length * (index - 1)) / 20);
      const end = Math.ceil((fixture.text.length * index) / 20);
      await gateway.emitGatewayEvent("chat", {
        sessionKey,
        runId,
        state: "delta",
        deltaText: fixture.text.slice(start, end),
        message: {
          role: "assistant",
          content: [{ type: "text", text: fixture.text.slice(0, end) }],
        },
      });
      await frames(page);
    }
  }
  await gateway.emitChatFinal({ sessionKey, runId, text: fixture.text });
  const bubble = page.locator(`${pane} .chat-bubble`).last();
  await bubble.waitFor();
  if (fixture.kind === "code") {
    await bubble.locator(".code-block-expand").waitFor();
    if (readiness === "preview") {
      await settleCode(page, fixture);
    }
  }
  if (fixture.kind === "table") {
    await bubble.locator("table tbody tr").last().waitFor();
  }
  if (fixture.kind === "images") {
    await bubble.locator("img").last().waitFor();
  }
  if (readiness !== "raw" || fixture.kind !== "code") {
    await frames(page);
  }
  if ((await bubble.getAttribute("data-message-text")) !== fixture.text) {
    throw new Error("Full source message was not retained");
  }
  if (fixture.kind === "code") {
    const actual = await bubble.locator("pre code").textContent();
    const expected = codeSource(fixture);
    if (actual !== expected) {
      throw new Error(`Code content mismatch: ${actual?.length} != ${expected.length}`);
    }
  }
  if (fixture.kind === "table" && (await bubble.locator("tbody tr").count()) !== 300) {
    throw new Error("Expected all 300 table rows");
  }
  if (fixture.kind === "images" && (await bubble.locator(".chat-text img").count()) !== 40) {
    throw new Error("Expected all 40 synthetic images");
  }
  if (
    fixture.kind === "fallback" &&
    !((await bubble.textContent()) ?? "").includes("const item = { value: 1 };")
  ) {
    throw new Error("Oversized fallback did not render");
  }
}

async function openTool(page: Page) {
  const group = page.locator(`${pane} .chat-activity-group__summary`).last();
  if ((await group.isVisible()) && (await group.getAttribute("aria-expanded")) !== "true") {
    await group.click();
  }
  const summary = page
    .locator(
      `${pane} .chat-tool-row__toggle:not(:disabled), ${pane} button.chat-tool-msg-summary:not(:disabled)`,
    )
    .last();
  await summary.waitFor();
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.press("Enter");
  }
  await page.locator(`${pane} .chat-tool-msg-body`).last().waitFor();
  await page.waitForLoadState("networkidle");
  await frames(page);
}

async function evidence(page: Page, fixture: Fixture) {
  return {
    ...(await page.evaluate(
      ({ selector, chars, kind }) => {
        const root = document.querySelector(selector)!;
        return {
          fixtureChars: chars,
          codeBlocks: root.querySelectorAll(".code-block-wrapper").length,
          highlightedSpans: root.querySelectorAll("code span").length,
          codeTextChars: [...root.querySelectorAll("pre code")].reduce(
            (sum, node) => sum + (node.textContent?.length ?? 0),
            0,
          ),
          tableRows: root.querySelectorAll("tbody tr").length,
          images: root.querySelectorAll("img").length,
          loadedImagePixels: [
            ...root.querySelectorAll<HTMLImageElement>(".chat-message-image"),
          ].reduce((total, image) => total + image.naturalWidth * image.naturalHeight, 0),
          diffRows: root.querySelectorAll(".chat-diff__row").length,
          contentIsFallback:
            kind === "fallback" && root.querySelectorAll(".code-block-wrapper").length === 0,
          domElements: root.querySelectorAll("*").length,
        };
      },
      { selector: pane, chars: fixture.text.length, kind: fixture.kind },
    )),
    ...(fixture.kind === "native-images"
      ? {
          encodedImageBytes: nativeImageSources!.reduce(
            (total, source) => total + source.length,
            0,
          ),
          binaryImageBytes: nativeImageSources!.reduce(
            (total, source) => total + Buffer.byteLength(source.split(",")[1]!, "base64"),
            0,
          ),
        }
      : {}),
    ...(await workerObservation(page)),
  };
}

async function setupHeavyContentPage(page: Page) {
  await page.addInitScript(() => {
    const observation: WorkerObservation = {
      starts: 0,
      replies: 0,
      errors: 0,
      terminations: 0,
      active: 0,
    };
    // SAFETY: This synthetic fixture owns its page and observation property.
    window.heavyContentWorkers = observation;
    window.heavyContentImageClipboard = [];
    const NativeWorker = window.Worker;
    const observed = new WeakSet<Worker>();
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!String(url).includes("markdown-code-highlight")) {
          return;
        }
        observed.add(this);
        observation.starts++;
        observation.active++;
        this.addEventListener("message", () => observation.replies++);
        this.addEventListener("error", () => observation.errors++);
      }
      override terminate() {
        if (observed.delete(this)) {
          observation.terminations++;
          observation.active--;
        }
        super.terminate();
      }
    };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        write: async (items: ClipboardItem[]) => {
          window.heavyContentImageClipboard = items;
        },
        writeText: async (text: string) => {
          // SAFETY: This scenario owns the page-local clipboard observation.
          (window as Window & { heavyContentCopied?: string }).heavyContentCopied = text;
        },
      },
    });
  });
}

export const heavyContentScenarios: InteractionScenario[] = heavyContentFixtures.flatMap(
  (fixture) => {
    const shared = {
      route: controlUiSessionPath(sessionKey),
      fixture: { heavyContent: true },
      resourceOnly: true,
      setup: async (page: Page) => {
        if (
          isDenseTool(fixture) &&
          (fixture.text.length < 150_000 ||
            fixture.text.length > 250_000 ||
            rawToolOutput(fixture).length > 2_000_000)
        ) {
          throw new Error("Dense tool source must stay within its stated workload and loader cap");
        }
        if (fixture.kind === "native-images") {
          // Generate once outside the measured interval; every arm receives identical bytes.
          nativeImageSources ??= createHeavyContentImageSources();
        }
        await setupHeavyContentPage(page);
      },
    };
    // Native image cards publish with the final message; Markdown images also stream.
    const streams = fixture.kind === "native-images" ? [false] : [false, true];
    const scenarios: InteractionScenario[] = streams.map((stream) => ({
      route: shared.route,
      fixture: shared.fixture,
      resourceOnly: shared.resourceOnly,
      setup: shared.setup,
      id: `heavy-${fixture.id}-${stream ? "stream" : "arrival"}`,
      expected: `${fixture.id}: complete ${fixture.text.length}-character synthetic content ${stream ? "streams in 20 frame-separated chunks" : "arrives in one event"}; raw content remains available.`,
      prepare,
      run: async (page, gateway) => {
        await deliver(page, gateway, fixture, stream);
        return evidence(page, fixture);
      },
    }));
    if (fixture.kind === "code") {
      for (const stream of [false, true]) {
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-raw-${stream ? "stream" : "arrival"}`,
          expected: "Complete source text is readable before deferred syntax decoration finishes.",
          prepare,
          run: async (page, gateway) => {
            await deliver(page, gateway, fixture, stream, "raw");
            return evidence(page, fixture);
          },
        });
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-full-${stream ? "stream" : "arrival"}`,
          expected:
            "Immediate expansion preserves the full source and finishes all syntax decoration.",
          prepare,
          run: async (page, gateway) => {
            await deliver(page, gateway, fixture, stream, "raw");
            await page.locator(`${pane} .code-block-expand`).last().click();
            await settleCode(page, fixture, true);
            return evidence(page, fixture);
          },
        });
      }
    }
    if (fixture.kind === "code" || fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-expand`,
        expected:
          fixture.kind === "tool"
            ? "The existing disclosure preserves its bounded inline preview and full-output action."
            : "The existing disclosure reveals the complete heavy content.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          if (fixture.kind === "tool") {
            await openTool(page);
            if (fixture.id === "tool-diff-error") {
              const raw = page.getByRole("tab", { name: "Raw", exact: true });
              if ((await raw.getAttribute("aria-selected")) !== "true") {
                throw new Error("Rejected patch did not default to its Raw output");
              }
              const output = page.locator(`${pane} [id$="-raw-panel"] code`);
              if ((await output.textContent()) !== rawToolOutput(fixture)) {
                throw new Error("Rejected patch did not show its complete error output");
              }
            }
          } else {
            await page.locator(`${pane} .code-block-expand`).last().click();
            await page.locator(`${pane} .code-block-wrapper.is-expanded`).last().waitFor();
            await settleCode(page, fixture, true);
          }
          return { ...(await evidence(page, fixture)), ...(await denseToolPreview(page, fixture)) };
        },
      });
    }
    if (fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-collapse`,
        expected: "The existing tool disclosure collapses after rendering its available output.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page) => {
          await page
            .locator(`${pane} .chat-tool-row__toggle, ${pane} button.chat-tool-msg-summary`)
            .last()
            .press("Enter");
          await page.locator(`${pane} .chat-tool-msg-body`).last().waitFor({ state: "hidden" });
          return evidence(page, fixture);
        },
      });
    }
    scenarios.push({
      ...shared,
      id: `heavy-${fixture.id}-scroll`,
      expected: "Native scrolling traverses every viewport band across the heavy content.",
      prepare: async (page, gateway) => {
        await prepare(page, gateway);
        await deliver(page, gateway, fixture, false);
        if (fixture.kind === "tool") {
          await openTool(page);
        }
        if (fixture.kind === "code") {
          await page.locator(`${pane} .code-block-expand`).last().click();
          await settleCode(page, fixture, true);
        }
      },
      run: async (page) => {
        const thread = page.locator(`${pane} .chat-thread`);
        await thread.hover();
        await page.mouse.wheel(0, -1_000_000);
        await frames(page);
        const geometry = await thread.evaluate((element) => ({
          top: element.scrollTop,
          height: element.clientHeight,
          travel: element.scrollHeight - element.clientHeight,
        }));
        if (geometry.height <= 0 || geometry.top > 2) {
          throw new Error("The content scroll fixture did not start at its visible top");
        }
        const distance = geometry.height * 0.75;
        const scrollSteps = Math.ceil(geometry.travel / distance);
        // Traverse viewport bands; a single jump skips intermediate paint and image work.
        for (let step = 0; step < scrollSteps; step++) {
          await page.mouse.wheel(0, distance);
          await frames(page);
        }
        const final = await thread.evaluate((element) => ({
          top: element.scrollTop,
          max: element.scrollHeight - element.clientHeight,
        }));
        if (final.top < final.max - 2) {
          throw new Error(
            `Heavy content stopped at ${final.top} before scroll bottom ${final.max}`,
          );
        }
        return {
          ...(await evidence(page, fixture)),
          scrollSteps,
          scrollStart: geometry.top,
          scrollEnd: final.top,
          scrollMax: final.max,
        };
      },
    });
    if (fixture.id === "tool-diff") {
      scenarios.push({
        ...shared,
        id: "heavy-tool-diff-tab-roundtrip",
        expected:
          "Diff to Raw to Diff preserves the existing bounded preview for 5,000 input lines.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page) => {
          await page.getByRole("tab", { name: "Raw", exact: true }).click();
          await page.locator(`${pane} .chat-tool-card__block-content`).last().waitFor();
          await page.getByRole("tab", { name: "Diff", exact: true }).click();
          await page.locator(`${pane} .chat-diff`).waitFor();
          await page.waitForLoadState("networkidle");
          await frames(page);
          const rows = await page.locator(`${pane} .chat-diff__row`).count();
          if (rows < 400 || rows > 402) {
            throw new Error(`Expected the existing 400-line preview cap, received ${rows} rows`);
          }
          return { ...(await evidence(page, fixture)), diffRows: rows };
        },
      });
    }
    if (fixture.kind === "tool") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-copy`,
        expected: "Opening full output and copying preserves every original character.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
          await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
          await page.locator(".chat-tool-output__actions").waitFor();
          await denseToolLoad(page, gateway, fixture);
        },
        run: async (page) => {
          await page
            .locator(".chat-tool-output__actions")
            .getByRole("button", { name: "Copy available output", exact: true })
            .click();
          const copied = await page.evaluate(() => {
            // SAFETY: The scenario's init script installs this clipboard observation.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          if (copied !== rawToolOutput(fixture)) {
            throw new Error(
              `Tool copy mismatch: ${copied?.length} != ${rawToolOutput(fixture).length}`,
            );
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
    }
    if (fixture.kind === "tool" && !fixture.id.startsWith("tool-diff")) {
      const openOutput = async (page: Page) => {
        await openTool(page);
        await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
        await page.locator(".chat-tool-output__text").waitFor();
      };
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-output-open`,
        expected: "The full tool-output sidebar formats all output.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
          await openTool(page);
        },
        run: async (page, gateway) => {
          await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
          await page.locator(".chat-tool-output__text").waitFor();
          const load = await denseToolLoad(page, gateway, fixture);
          const shown = (await page.locator(".chat-tool-output__text").textContent()) ?? "";
          const expected =
            fixture.id === "json-format"
              ? JSON.stringify(JSON.parse(fixture.text), null, 2)
              : fixture.text;
          if (shown !== expected) {
            throw new Error("Full output display did not preserve the fixture");
          }
          return {
            ...(await evidence(page, fixture)),
            outputChars: shown.length,
            ...load,
          };
        },
      });
      if (isDenseTool(fixture)) {
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-output-scroll`,
          expected:
            "Native scrolling traverses the complete loaded dense output in the existing sidebar.",
          prepare: async (page, gateway) => {
            await prepare(page, gateway);
            await deliver(page, gateway, fixture, false);
            await openOutput(page);
            await denseToolLoad(page, gateway, fixture);
          },
          run: async (page) => {
            const output = page.locator("openclaw-chat-tool-output");
            await output.hover();
            await page.mouse.wheel(0, -1_000_000);
            await frames(page);
            const geometry = await output.evaluate((element) => ({
              top: element.scrollTop,
              height: element.clientHeight,
              travel: element.scrollHeight - element.clientHeight,
            }));
            if (geometry.height <= 0 || geometry.top > 2 || geometry.travel <= 0) {
              throw new Error("Dense output sidebar did not expose its full scroll range");
            }
            const distance = geometry.height * 0.75;
            const scrollSteps = Math.ceil(geometry.travel / distance);
            for (let step = 0; step < scrollSteps; step++) {
              await page.mouse.wheel(0, distance);
              await frames(page);
            }
            const final = await output.evaluate((element) => ({
              top: element.scrollTop,
              max: element.scrollHeight - element.clientHeight,
            }));
            if (final.top < final.max - 2) {
              throw new Error("Dense output scrolling did not reach the complete source's bottom");
            }
            return {
              sourceChars: fixture.text.length,
              scrollSteps,
              scrollStart: geometry.top,
              scrollEnd: final.top,
              scrollMax: final.max,
            };
          },
        });
      }
      if (fixture.id.startsWith("json")) {
        scenarios.push({
          ...shared,
          id: `heavy-${fixture.id}-raw-toggle`,
          expected:
            "Raw JSON mounts only on disclosure, remains complete, and unmounts on collapse.",
          prepare: async (page, gateway) => {
            await prepare(page, gateway);
            await deliver(page, gateway, fixture, false);
            await openOutput(page);
            await denseToolLoad(page, gateway, fixture);
          },
          run: async (page) => {
            const toggle = page.locator(".chat-tool-output .chat-tool-card__raw-toggle");
            await toggle.click();
            const raw = page.locator(".chat-tool-output .chat-tool-card__raw-body code");
            if ((await raw.textContent()) !== rawToolOutput(fixture)) {
              throw new Error("Raw output mismatch");
            }
            await toggle.click();
            await raw.waitFor({ state: "hidden" });
            return evidence(page, fixture);
          },
        });
      }
    }
    if (fixture.kind === "code") {
      scenarios.push({
        ...shared,
        id: `heavy-${fixture.id}-copy`,
        expected: "The copy action supplies every source character, including the collapsed tail.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          await page.locator(`${pane} .code-block-copy`).last().click();
          const copied = await page.evaluate(() => {
            // SAFETY: The scenario's init script installs this clipboard observation.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          const source =
            "code" in fixture
              ? fixture.code
              : fixture.text.slice(fixture.text.indexOf("\n") + 1, -3);
          const expected = source.replace(/\n$/, "");
          if (copied !== expected) {
            throw new Error(`Copy mismatch: ${copied?.length} != ${expected.length}`);
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
      if (fixture.id === "code") {
        scenarios.push({
          ...shared,
          id: "heavy-code-retirement-gc",
          diagnostic: "Forced-GC component-retirement probe; not CPU or latency acceptance.",
          expected:
            "Ten replacements of one canonical message retire every code island and worker; post-clear heap samples expose retention.",
          prepare: async () => {},
          run: async (page, gateway) => {
            const cdp = await page.context().newCDPSession(page);
            const session = await gateway.getSessionRow(sessionKey);
            const heapPoints: number[] = [];
            const report: Record<string, number | boolean> = {};
            const publish = async (text: string) => {
              const message = {
                role: "assistant",
                content: [{ type: "text", text }],
                timestamp: Date.now(),
                __openclaw: { id: "heavy-retirement-result", seq: 1 },
              };
              await gateway.setMethodResponse("chat.history", {
                sessionId: session.sessionId,
                messages: [message],
              });
              // A bodyless committed-message event requests an authoritative history refresh.
              // Replacing an already-persisted live row is not the live append contract.
              await gateway.emitGatewayEvent("sessions.changed", {
                sessionKey,
                phase: "message",
              });
              await page.waitForFunction(
                ({ rootSelector, expectedText }) =>
                  [...document.querySelectorAll(`${rootSelector} .chat-bubble`)].some(
                    (bubble) => bubble.getAttribute("data-message-text") === expectedText,
                  ),
                { rootSelector: pane, expectedText: text },
              );
            };
            try {
              await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              for (let round = 0; round < 10; round++) {
                const previous = await workerObservation(page);
                const code = `let ${round % 2 ? "b" : "a"};\n`.repeat(5_000);
                const next: typeof fixture = { ...fixture, code, text: `\`\`\`ts\n${code}\`\`\`` };
                await publish(next.text);
                const block = page.locator(`${pane} .code-block-wrapper`).last();
                await block.waitFor();
                if (round < 2) {
                  await block.locator(".code-block-expand").click();
                  await settleCode(page, next, true);
                } else if (
                  (await block.locator("pre code").getAttribute("data-code-highlight")) !== null
                ) {
                  await page.waitForFunction(
                    (priorStarts) => window.heavyContentWorkers.starts > priorStarts,
                    previous.starts,
                  );
                }
                await publish("Retired synthetic code content.");
                await page.locator(`${pane} .code-block-wrapper`).waitFor({ state: "detached" });
                await page.waitForFunction(() => window.heavyContentWorkers.active === 0);
                await page.waitForLoadState("networkidle");
                await frames(page);
                await cdp.send("HeapProfiler.collectGarbage");
                const measured: { metrics: Array<{ name: string; value: number }> } =
                  await cdp.send("Performance.getMetrics");
                const heapBytes = measured.metrics.find(
                  ({ name }) => name === "JSHeapUsedSize",
                )?.value;
                if (heapBytes === undefined) {
                  throw new Error("The forced-GC probe did not receive a heap sample");
                }
                heapPoints.push(heapBytes);
                report[`heapAfterClear${round + 1}Bytes`] = heapBytes;
              }
              const observed = await workerObservation(page);
              if (observed.active || observed.errors || observed.starts !== observed.terminations) {
                throw new Error("Retired code left an active or failed highlighting worker");
              }
              const settled = heapPoints.slice(2);
              return {
                ...(await evidence(page, fixture)),
                ...report,
                forcedGcRounds: heapPoints.length,
                postWarmupHeapMinBytes: Math.min(...settled),
                postWarmupHeapMaxBytes: Math.max(...settled),
                postWarmupHeapChangeBytes: settled.at(-1)! - settled[0]!,
              };
            } finally {
              await cdp.detach();
            }
          },
        });
        scenarios.push({
          ...shared,
          id: "heavy-code-selection",
          expected:
            "Selecting pending source preserves the selection; complete syntax resumes after it clears.",
          prepare: async (page, gateway) => {
            await prepare(page, gateway);
            await deliver(page, gateway, fixture, false);
          },
          run: async (page) => {
            const selected = await page.evaluate((rootSelector) => {
              const block = [
                ...document.querySelectorAll(`${rootSelector} .code-block-wrapper`),
              ].at(-1)!;
              const code = block.querySelector("pre code")!;
              block.querySelector<HTMLButtonElement>(".code-block-expand")!.click();
              const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
              const range = document.createRange();
              let offset = 0;
              let node: Node | null;
              while ((node = walker.nextNode())) {
                const end = offset + (node.textContent?.length ?? 0);
                if (offset <= 2_000 && end > 2_000) {
                  range.setStart(node, 2_000 - offset);
                }
                if (offset < 2_070 && end >= 2_070) {
                  range.setEnd(node, 2_070 - offset);
                  break;
                }
                offset = end;
              }
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            }, pane);
            if (selected !== codeSource(fixture).slice(2_000, 2_070)) {
              throw new Error("Selection setup did not select the requested source substring");
            }
            await page.evaluate(async () => {
              for (let frame = 0; frame < 8; frame++) {
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
              }
            });
            const after = await page.evaluate(() => window.getSelection()?.toString());
            if (after !== selected) {
              throw new Error(
                `Syntax decoration changed selected text from ${selected.length} to ${after?.length ?? 0} characters`,
              );
            }
            const code = page.locator(`${pane} .chat-bubble`).last().locator("pre code");
            if ((await code.textContent()) !== codeSource(fixture)) {
              throw new Error("Selection pause changed the complete source text");
            }
            await page.evaluate(() => window.getSelection()?.removeAllRanges());
            await settleCode(page, fixture, true);
            const highlightedSelection = await page.evaluate((rootSelector) => {
              const keyword = document.querySelector(`${rootSelector} pre code .hljs-keyword`)!;
              const range = document.createRange();
              range.selectNodeContents(keyword);
              const selection = window.getSelection()!;
              selection.removeAllRanges();
              selection.addRange(range);
              return selection.toString();
            }, pane);
            if (highlightedSelection !== "let") {
              throw new Error("Completed syntax did not retain native keyword selection");
            }
            return {
              ...(await evidence(page, fixture)),
              selectedChars: selected.length,
              finalHighlightedSelectionChars: highlightedSelection.length,
            };
          },
        });
        scenarios.push({
          ...shared,
          id: "heavy-code-sequential",
          expected:
            "Three sequential complete 5,000-line blocks retain their text and finish each worker before the next arrives.",
          prepare,
          run: async (page, gateway) => {
            for (const [index, name] of ["a", "b", "c"].entries()) {
              if (index > 0) {
                await prepare(page, gateway);
              }
              const code = `let ${name};\n`.repeat(5_000);
              const next: typeof fixture = { ...fixture, code, text: `\`\`\`ts\n${code}\`\`\`` };
              await deliver(page, gateway, next, false, "raw");
              await page.locator(`${pane} .code-block-expand`).last().click();
              await settleCode(page, next, true);
            }
            const complete = await evidence(page, fixture);
            if (complete.codeBlocks !== 3 || complete.codeTextChars !== 105_000) {
              throw new Error("Sequential blocks did not retain their complete source");
            }
            return complete;
          },
        });
      }
    }
    if (fixture.kind === "table") {
      scenarios.push({
        ...shared,
        id: "heavy-table-copy",
        expected: "The table copy action preserves every header and cell as tab-separated text.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          await page.locator(`${pane} .markdown-table__copy`).last().click();
          const copied = await page.evaluate(() => {
            // SAFETY: Installed by this fixture's clipboard init script.
            return (window as Window & { heavyContentCopied?: string }).heavyContentCopied;
          });
          const expected = [
            Array.from({ length: 12 }, (_, column) => `C${column}`).join("\t"),
            ...Array.from({ length: 300 }, (_, row) =>
              Array.from({ length: 12 }, (_cell, column) => `${row}-${column}`).join("\t"),
            ),
          ].join("\n");
          if (copied !== expected) {
            throw new Error(`Table copy mismatch: ${copied?.length} != ${expected.length}`);
          }
          return { ...(await evidence(page, fixture)), copiedChars: copied.length };
        },
      });
    }
    if (fixture.id === "large-input") {
      for (const surface of ["card", "sidebar"] as const) {
        const selector =
          surface === "card" ? `${pane} .chat-tool-card__input` : ".chat-tool-output details";
        const readInput = async (page: Page, open: boolean) =>
          page.evaluate(
            ({ selector: inputSelector, surface: inputSurface, open: expectedOpen }) => {
              const details = document.querySelector<HTMLDetailsElement>(inputSelector);
              if (!details || details.open !== expectedOpen) {
                throw new Error(`Tool Input ${inputSurface} did not reach open=${expectedOpen}`);
              }
              const expected = window.heavyContentExpectedInput![inputSurface];
              const content = details.querySelector(inputSurface === "card" ? "pre code" : "pre");
              const fullInputMounted = content?.textContent === expected;
              if (expectedOpen && !fullInputMounted) {
                throw new Error(`Tool Input ${inputSurface} did not preserve its complete source`);
              }
              return {
                detailsOpen: details.open,
                expectedChars: expected.length,
                sourceLines: 5_000,
                descendantElements: details.querySelectorAll("*").length,
                descendantTextChars: details.textContent?.length ?? 0,
                preElements: details.querySelectorAll("pre").length,
                codeElements: details.querySelectorAll("code").length,
                fullInputMounted,
              };
            },
            { selector, surface, open },
          );
        const openSidebar = async (page: Page, gateway: MockGatewayControls) => {
          await page.locator(`${pane} .chat-tool-card__action-btn`).last().click();
          await gateway.waitForRequest("chat.message.get", {
            match: { sessionKey, messageId: "heavy-result", maxChars: 2_000_000 },
          });
          await assertToolOutputLoaded(page);
          if ((await page.locator(".chat-tool-output__text").textContent()) !== fixture.text) {
            throw new Error("Large Tool Input changed its tiny output");
          }
        };
        for (const state of ["closed", "first-open", "reopen"] as const) {
          scenarios.push({
            ...shared,
            id: `heavy-input-${surface}-${state}`,
            expected: `The ${surface} Tool Input disclosure ${state} preserves all 5,000 lines and the independent tiny output.`,
            prepare: async (page, gateway) => {
              await prepare(page, gateway);
              await page.evaluate((input) => {
                window.heavyContentExpectedInput = {
                  card: input,
                  sidebar: JSON.stringify({ input }, null, 2),
                };
              }, largeInputSource);
              await deliver(page, gateway, fixture, false);
              if (surface === "sidebar" || state !== "closed") {
                await openTool(page);
              }
              if (surface === "sidebar" && state !== "closed") {
                await openSidebar(page, gateway);
              }
              if (state === "reopen") {
                await page.locator(`${selector} > summary`).click();
                await frames(page);
                await readInput(page, true);
                await page.locator(`${selector} > summary`).click();
                await frames(page);
                await readInput(page, false);
              }
            },
            run: async (page, gateway) => {
              if (state === "closed") {
                if (surface === "card") {
                  await openTool(page);
                } else {
                  await openSidebar(page, gateway);
                }
              } else {
                await page.locator(`${selector} > summary`).click();
              }
              await frames(page);
              return readInput(page, state !== "closed");
            },
          });
        }
      }
    }
    if (fixture.id === "nested-input-large" || fixture.id === "nested-input-small") {
      scenarios.push({
        ...shared,
        id: `heavy-input-nested-${fixture.id === "nested-input-large" ? "large" : "small"}`,
        expected:
          "Generic nested argument expansion retains its existing exact 400-character preview after canonical input serialization completed outside timing.",
        prepare: async (page, gateway) => {
          await prepare(page, gateway);
          const expected = JSON.stringify(fixture.inputArgs.payload).slice(0, 400);
          if (expected !== JSON.stringify({ rows: nestedInputRows }).slice(0, 400)) {
            throw new Error("Nested argument control did not retain the same preview prefix");
          }
          await page.evaluate((preview) => {
            window.heavyContentExpectedNestedInput = preview;
          }, expected);
          await deliver(page, gateway, fixture, false);
        },
        run: async (page) => {
          await openTool(page);
          return page.evaluate(
            ({ selector, rows }) => {
              const fields = document.querySelectorAll(`${selector} .chat-tool-kv__row`);
              const field = fields[0];
              const key = field?.querySelector(".chat-tool-kv__key")?.textContent;
              const value = field?.querySelector(".chat-tool-kv__value")?.textContent;
              if (
                fields.length !== 1 ||
                key !== "payload:" ||
                value !== window.heavyContentExpectedNestedInput
              ) {
                throw new Error("Generic nested arguments changed their existing preview");
              }
              return { nestedRows: rows, previewChars: value!.length, exactPreview: true };
            },
            { selector: pane, rows: fixture.inputArgs.payload.rows.length },
          );
        },
      });
    }
    return scenarios;
  },
);

const imageCopyEvidence = new WeakMap<Page, InteractionEvidence>();
const imageCopyRequests = new WeakMap<Page, { thumbnail: number; full: number }>();
const imageCopySource = `/api/chat/media/outgoing/${encodeURIComponent(sessionKey)}/heavy-copy/full`;

heavyContentScenarios.push({
  id: "heavy-managed-image-copy",
  route: controlUiSessionPath(sessionKey),
  fixture: { heavyContent: true },
  resourceOnly: true,
  diagnostic:
    "Native image copy correctness; copyReadyMs separately records one exploratory automation-to-blob-readiness interval before byte validation.",
  expected:
    "The native Copy image action publishes the original 1024×1024 PNG through a native ClipboardItem without touching the OS clipboard.",
  setup: async (page) => {
    nativeImageSources ??= createHeavyContentImageSources();
    await setupHeavyContentPage(page);
    const bytes = Buffer.from(nativeImageSources[0]!.split(",")[1]!, "base64");
    const requests = { thumbnail: 0, full: 0 };
    imageCopyRequests.set(page, requests);
    await page.route("**/api/chat/media/outgoing/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.includes("/heavy-copy/")) {
        await route.fallback();
        return;
      }
      if (path.endsWith("/thumbnail")) {
        requests.thumbnail++;
        await route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
      } else if (path.endsWith("/full")) {
        requests.full++;
        await route.fulfill({ contentType: "image/png", body: bytes });
      } else {
        throw new Error("Image copy requested an unexpected managed image variant");
      }
    });
  },
  prepare: async (page, gateway) => {
    await prepare(page, gateway);
    await gateway.emitGatewayEvent("chat", {
      sessionKey,
      runId: runs.get(page)!,
      state: "final",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "A synthetic managed image for native PNG copy proof." },
          {
            type: "image",
            url: imageCopySource,
            alt: "Synthetic managed PNG",
            width: 1_024,
            height: 1_024,
          },
        ],
        timestamp: Date.now(),
      },
    });
    const frame = page.locator(`${pane} .chat-image-frame`).last();
    await frame.locator("img.chat-message-image").waitFor();
    await frame.hover();
    const copy = frame.getByRole("button", { name: "Copy image", exact: true });
    await copy.waitFor();
    const fullRequestsBefore = imageCopyRequests.get(page)!.full;
    const start = performance.now();
    await copy.click();
    const copiedBytes = await page.evaluate(async () => {
      const items = window.heavyContentImageClipboard;
      if (items.length !== 1 || !(items[0] instanceof ClipboardItem)) {
        throw new Error("Copy image did not publish one native ClipboardItem");
      }
      window.heavyContentCopiedImage = await items[0].getType("image/png");
      return window.heavyContentCopiedImage.size;
    });
    const copyReadyMs = performance.now() - start;
    const requests = imageCopyRequests.get(page)!;
    if (requests.thumbnail === 0 || requests.full <= fullRequestsBefore) {
      throw new Error("Native image copy did not load its original after the distinct thumbnail");
    }
    // Deep validation is outside the action-to-readiness interval.
    const receipt = await page.evaluate(async (source) => {
      const blob = window.heavyContentCopiedImage!;
      const actual = new Uint8Array(await blob.arrayBuffer());
      const expected = Uint8Array.from(atob(source.split(",")[1]!), (char) => char.charCodeAt(0));
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (
        blob.type !== "image/png" ||
        actual.length !== expected.length ||
        !actual.every((byte, index) => byte === expected[index]) ||
        !signature.every((byte, index) => byte === actual[index]) ||
        String.fromCharCode(...actual.subarray(12, 16)) !== "IHDR"
      ) {
        throw new Error("Native image copy changed the original encoded PNG bytes");
      }
      const header = new DataView(actual.buffer, actual.byteOffset, actual.byteLength);
      const width = header.getUint32(16);
      const height = header.getUint32(20);
      if (width !== 1_024 || height !== 1_024) {
        throw new Error("Copied PNG lost its original dimensions");
      }
      return { exactEncodedBytes: true, pngWidth: width, pngHeight: height };
    }, nativeImageSources![0]!);
    imageCopyEvidence.set(page, {
      ...receipt,
      copiedBytes,
      copyReadyMs,
      thumbnailRequests: requests.thumbnail,
      originalRequests: requests.full,
    });
  },
  run: async (page) => imageCopyEvidence.get(page)!,
});

// The real attachment reader caps text at 256 KiB; this fenced document is 258,899 B.
const denseCode = Array.from(
  { length: 5_000 },
  (_, index) =>
    `const item${String(index).padStart(4, "0")} = { n: ${index}, ok: true, s: "v${String(index).padStart(4, "0")}" };\n`,
).join("");
const denseDocument = `\`\`\`ts\n${denseCode}\`\`\``;
const denseMessage = `\`\`\`ts\n${Array.from(
  { length: 5_000 },
  (_, index) =>
    `const item${index} = { n: ${index}, ok: true, s: "value-${index}" }; // synthetic dense stream ${index}\n`,
).join("")}\`\`\``;
const denseMediaSource = "media://inbound/heavy-dense-markdown";
const densePanel = "openclaw-chat-detail-panel";
const denseArticle = `${densePanel} article.sidebar-attachment-preview__markdown`;
const denseShared = {
  route: controlUiSessionPath(sessionKey),
  fixture: { heavyContent: true },
  resourceOnly: true,
  setup: async (page: Page) => {
    await setupHeavyContentPage(page);
    await page.route("**/__openclaw__/assistant-media?*", async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get("source") !== denseMediaSource) {
        await route.fallback();
        return;
      }
      if (url.searchParams.get("meta") === "1") {
        await route.fulfill({
          json: {
            available: true,
            mediaTicket: "heavy-dense-ticket",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            sizeBytes: denseDocument.length,
          },
        });
        return;
      }
      if (url.searchParams.get("mediaTicket") !== "heavy-dense-ticket") {
        throw new Error("Dense attachment body read did not carry its resolved media ticket");
      }
      await route.fulfill({ contentType: "text/markdown; charset=utf-8", body: denseDocument });
    });
  },
};

async function openDenseAttachment(page: Page, gateway: MockGatewayControls) {
  await gateway.emitGatewayEvent("chat", {
    sessionKey,
    runId: runs.get(page)!,
    state: "final",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "A dense synthetic TypeScript document." },
        {
          type: "attachment",
          attachment: {
            url: denseMediaSource,
            kind: "document",
            label: "dense.md",
            mimeType: "text/markdown",
            sizeBytes: denseDocument.length,
          },
        },
      ],
      __openclaw: { id: "heavy-dense-document" },
      timestamp: Date.now(),
    },
  });
  await page
    .locator(`${pane} .chat-assistant-attachment-card--compact`)
    .filter({ hasText: "dense.md" })
    .getByRole("button", { name: "Open dense.md in the side panel", exact: true })
    .click();
  await page.locator(`${denseArticle} .code-block-expand`).click({ timeout: 60_000 });
  await page.waitForFunction(
    ({ selector, source }) => {
      const code = document.querySelector(`${selector} pre code`);
      return (
        code?.textContent === source &&
        code.querySelectorAll(".hljs-keyword").length === 5_000 &&
        code.querySelectorAll(".hljs-string").length === 5_000 &&
        code.querySelectorAll(".hljs-number").length === 5_000 &&
        window.heavyContentWorkers.active === 0
      );
    },
    { selector: denseArticle, source: denseCode },
  );
  await frames(page);
}

async function denseAttachmentEvidence(page: Page) {
  return {
    ...(await page.locator(denseArticle).evaluate((article) => ({
      codeTextChars: article.querySelector("pre code")?.textContent?.length ?? 0,
      highlightedSpans: article.querySelectorAll("pre code span").length,
      keywordSpans: article.querySelectorAll(".hljs-keyword").length,
      stringSpans: article.querySelectorAll(".hljs-string").length,
      numberSpans: article.querySelectorAll(".hljs-number").length,
      domElements: article.querySelectorAll("*").length,
    }))),
    fixtureChars: denseDocument.length,
    supportedReaderCapBytes: 256 * 1024,
    sourceLines: 5_000,
    ...(await workerObservation(page)),
  };
}

heavyContentScenarios.push(
  {
    ...denseShared,
    id: "heavy-dense-attachment-full-arrival",
    expected:
      "A real ticketed Markdown attachment preserves all 5,000 dense TypeScript lines and completes expanded syntax decoration within the existing 256 KiB reader contract.",
    prepare,
    run: async (page, gateway) => {
      await openDenseAttachment(page, gateway);
      return denseAttachmentEvidence(page);
    },
  },
  {
    ...denseShared,
    id: "heavy-dense-attachment-full-scroll",
    expected:
      "Native scrolling traverses the expanded dense attachment; both existing copy actions preserve their complete source contract.",
    prepare: async (page, gateway) => {
      await prepare(page, gateway);
      await openDenseAttachment(page, gateway);
      await page
        .locator(`${densePanel} .sidebar-file-toolbar__actions`)
        .getByRole("button", { name: "Copy", exact: true })
        .click();
      await page.waitForFunction(
        (expected) =>
          (window as Window & { heavyContentCopied?: string }).heavyContentCopied === expected,
        denseDocument,
      );
      const documentCopy = await page.evaluate(
        () => (window as Window & { heavyContentCopied?: string }).heavyContentCopied,
      );
      if (documentCopy !== denseDocument) {
        throw new Error("Dense attachment toolbar copy did not preserve the complete Markdown");
      }
      await page.locator(`${denseArticle} .code-block-copy`).click();
      await page.waitForFunction(
        (expected) =>
          (window as Window & { heavyContentCopied?: string }).heavyContentCopied === expected,
        denseCode.replace(/\n$/u, ""),
      );
      const sourceCopy = await page.evaluate(
        () => (window as Window & { heavyContentCopied?: string }).heavyContentCopied,
      );
      if (sourceCopy !== denseCode.replace(/\n$/u, "")) {
        throw new Error(
          "Dense attachment code copy did not preserve the existing terminal-LF contract",
        );
      }
    },
    run: async (page) => {
      const scroller = page.locator(`${densePanel} .sidebar-content`);
      await scroller.hover();
      await page.mouse.wheel(0, -100_000);
      await frames(page);
      const geometry = await scroller.evaluate((element) => ({
        height: element.clientHeight,
        travel: element.scrollHeight - element.clientHeight,
        top: element.scrollTop,
      }));
      if (geometry.height <= 0 || geometry.travel <= 0) {
        throw new Error("Dense attachment did not expose its scrollable full source");
      }
      const distance = geometry.height * 0.75;
      const scrollSteps = Math.ceil(geometry.travel / distance);
      for (let step = 0; step < scrollSteps; step++) {
        await page.mouse.wheel(0, distance);
        await frames(page);
      }
      const final = await scroller.evaluate((element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight,
      }));
      if (final.top < final.max - 2) {
        throw new Error(
          `Dense attachment stopped at ${final.top} before scroll bottom ${final.max}`,
        );
      }
      return {
        ...(await denseAttachmentEvidence(page)),
        scrollSteps,
        scrollStart: geometry.top,
        scrollEnd: final.top,
        scrollMax: final.max,
        completeCopies: 2,
      };
    },
  },
  {
    ...denseShared,
    id: "heavy-dense-message-stream",
    expected:
      "A dense message above 300 KiB follows the existing literal-text and 140,000-character presentation limits while retaining the complete message source.",
    prepare,
    run: async (page, gateway) => {
      const runId = runs.get(page)!;
      for (let index = 1; index <= 20; index++) {
        const start = Math.ceil((denseMessage.length * (index - 1)) / 20);
        const end = Math.ceil((denseMessage.length * index) / 20);
        await gateway.emitGatewayEvent("chat", {
          sessionKey,
          runId,
          state: "delta",
          deltaText: denseMessage.slice(start, end),
          message: {
            role: "assistant",
            content: [{ type: "text", text: denseMessage.slice(0, end) }],
          },
        });
        await frames(page);
      }
      await gateway.emitChatFinal({ sessionKey, runId, text: denseMessage });
      const bubble = page.locator(`${pane} .chat-bubble`).last();
      const fallback = bubble.locator(".markdown-plain-text-fallback");
      await fallback.waitFor();
      const shown = await fallback.evaluate(
        (element) =>
          (element.querySelector(".markdown-plain-text-source") ?? element).textContent ?? "",
      );
      if (
        (await bubble.getAttribute("data-message-text")) !== denseMessage ||
        !shown.startsWith(denseMessage.slice(0, 140_000)) ||
        shown.length <= 140_000 ||
        shown.length > 142_000 ||
        (await bubble.locator(".code-block-wrapper").count()) !== 0
      ) {
        throw new Error(
          "Dense message changed the existing source-retention or truncated-fallback contract",
        );
      }
      await page.waitForFunction(() => window.heavyContentWorkers.active === 0);
      await frames(page);
      return {
        fixtureChars: denseMessage.length,
        displayedChars: shown.length,
        presentationLimitChars: 140_000,
        contentIsFallback: true,
        sourceLines: 5_000,
        ...(await workerObservation(page)),
      };
    },
  },
);

import { setTimeout as delay } from "node:timers/promises";
import type { JSHandle, Page } from "playwright";
import type { AgentEvent } from "../../packages/gateway-protocol/src/schema/agent.ts";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import type {
  MockGatewayControls,
  MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { reconnectMockGateway } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { frames } from "./control-ui-interaction-navigation.ts";
import type {
  InteractionFixtureOverrides,
  InteractionScenario,
} from "./control-ui-interaction-scenarios.ts";

const population = 1_000;
const retainedRows = 100;
const activeSessions = 20;
const tools = ["read", "exec", "web_fetch", "write"] as const;
const route = `${pathForRoute("activity")}?view=live`;
const streamSelector = "#activity-live-panel .activity-stream";
const rowSelector = `${streamSelector} .activity-entry`;
const sessionKey = (index: number) => `agent:main:data-live-${index % activeSessions}`;
const toolId = (index: number) => `data-live-tool-${String(index).padStart(5, "0")}`;

type ToolData = { name: string; toolCallId: string } & (
  | { phase: "start"; args: { path: string; limit: number } }
  | { phase: "update"; partialResult: { text: string } }
  | { phase: "result"; result: { text: string; isError: boolean } }
);

// session.tool carries the agent envelope plus the Gateway's session routing metadata.
type ToolEvent = AgentEvent & {
  stream: "tool";
  sessionKey: string;
  agentId: "main";
  data: ToolData;
};

const initialBursts = new WeakMap<Page, JSHandle<ToolEvent[]>>();

async function prepareInitialBurst(
  page: Page,
  gateway: MockGatewayControls,
  output: "ascii" | "unicode" | "changed" = "ascii",
) {
  await ready(page, gateway);
  const events = toolEvents(0, population, output === "unicode" ? "unicode" : "ascii");
  if (output === "changed") {
    for (const payload of events) {
      if (payload.data.phase === "result") {
        const { result } = payload.data;
        result.text = `${result.text.slice(0, 1_999)}!${result.text.slice(2_000)}`;
      }
    }
  }
  // Stage automation's multi-megabyte argument decoding outside the product interval.
  initialBursts.set(page, await page.evaluateHandle((payloads) => payloads, events));
}

async function emitInitialBurst(page: Page) {
  const events = initialBursts.get(page);
  if (!events) {
    throw new Error("Missing prepared Activity Live burst");
  }
  initialBursts.delete(page);
  try {
    await emitBurst(page, events);
  } finally {
    await events.dispose();
  }
}

function createDataActivityLiveFixture(): InteractionFixtureOverrides {
  const now = Date.now();
  return {
    sessions: Array.from({ length: activeSessions }, (_, index) => ({
      key: sessionKey(index),
      sessionId: `data-live-session-${index}`,
      kind: "direct",
      agentId: "main",
      label: `Data live session ${index}`,
      hasActiveRun: true,
      status: "running",
      updatedAt: now,
      lastActivityAt: now,
    })),
  };
}

function event(index: number, phaseOffset: number, data: ToolData): ToolEvent {
  return {
    runId: `data-live-run-${index % activeSessions}`,
    seq: index * 3 + phaseOffset,
    stream: "tool",
    ts: Date.now() - 1_000,
    sessionKey: sessionKey(index),
    agentId: "main",
    data,
  };
}

const unicodeLine = "解析完了 | café e\u0301 | Ελληνικά | مرحبًا | नमस्ते | 🦞🚀\n";

function unicodePreview(index: number): string {
  const malformedDiagnostic = index % 20 === 0 ? "Raw code units: \ud800 / \udc00\n" : "";
  const prefix = `${toolId(index)} ${index % 10 === 0 ? "activity-live-needle" : "routine"}\n${unicodeLine.repeat(12)}${malformedDiagnostic}`;
  // The following astral character straddles the cap only for the 1,999-unit prefix.
  return prefix.padEnd(index % 2 === 0 ? 1_999 : 2_000, "進行中 ");
}

function toolEvents(
  start: number,
  count: number,
  output: "ascii" | "unicode" = "ascii",
): ToolEvent[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    const identity = { name: tools[index % tools.length]!, toolCallId: toolId(index) };
    const text =
      output === "unicode"
        ? `${unicodePreview(index)}🦞${unicodeLine.repeat(40)}`
        : `${toolId(index)} ${index % 10 === 0 ? "activity-live-needle" : "routine"}\n${"Synthetic tool output for Activity Live.\n".repeat(80)}`;
    return [
      event(index, 1, {
        ...identity,
        phase: "start",
        args: { path: `/synthetic/activity/${index}.txt`, limit: 100 },
      }),
      event(index, 2, { ...identity, phase: "update", partialResult: { text } }),
      ...(index % 5 === 0
        ? []
        : [
            event(index, 3, {
              ...identity,
              phase: "result",
              result: { text, isError: index % 5 === 1 },
            }),
          ]),
    ];
  }).flat();
}

async function emitBurst(page: Page, events: ToolEvent[] | JSHandle<ToolEvent[]>) {
  // One browser task models queued delivery, without one automation round trip per event.
  await page.evaluate((payloads) => {
    // SAFETY: installMockGateway owns this documented browser test surface.
    const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
    if (!gateway) {
      throw new Error("Missing mock Gateway transport");
    }
    for (const payload of payloads) {
      gateway.emit("session.tool", payload);
    }
  }, events);
}

async function ready(page: Page, gateway: MockGatewayControls) {
  await page.locator("#activity-live-panel").waitFor();
  await gateway.waitForRequest("sessions.list", {
    match: { source: "activity", activeOnly: true },
  });
  await Promise.all(
    Array.from({ length: activeSessions }, (_, index) =>
      gateway.waitForRequest("sessions.messages.subscribe", { match: { key: sessionKey(index) } }),
    ),
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll(".activity-current-work__row").length === count,
    activeSessions,
  );
}

async function expectWindow(page: Page, first: number, last: number) {
  await page.waitForFunction(
    ({ selector, firstId, lastId, count }) => {
      const rows = document.querySelectorAll(selector);
      return (
        rows.length === count &&
        rows[0]?.textContent?.includes(firstId) &&
        rows[rows.length - 1]?.textContent?.includes(lastId)
      );
    },
    { selector: rowSelector, firstId: toolId(first), lastId: toolId(last), count: retainedRows },
  );
}

async function atCapacity(page: Page, gateway: MockGatewayControls) {
  await ready(page, gateway);
  await emitBurst(page, toolEvents(0, population));
  await expectWindow(page, 900, 999);
  await frames(page);
}

async function expectCount(page: Page, count: number) {
  await page.waitForFunction(
    ({ selector, expectedCount }) => document.querySelectorAll(selector).length === expectedCount,
    { selector: rowSelector, expectedCount: count },
  );
}

async function verifyCapacity(page: Page) {
  const counts = await page.locator(streamSelector).evaluate((stream) => ({
    running: stream.querySelectorAll(".activity-entry--running").length,
    done: stream.querySelectorAll(".activity-entry--done").length,
    error: stream.querySelectorAll(".activity-entry--error").length,
    previews: [...stream.querySelectorAll(".activity-entry__preview")].map(
      (preview) => preview.textContent?.length ?? 0,
    ),
  }));
  if (
    counts.running !== 20 ||
    counts.done !== 60 ||
    counts.error !== 20 ||
    counts.previews.length !== 100 ||
    counts.previews.some((length) => length !== 2_000)
  ) {
    throw new Error(`Unexpected retained Activity Live contents: ${JSON.stringify(counts)}`);
  }
  return { populationTools: population, activeSessions, retainedRows, deliveredEvents: 2_800 };
}

const pacedPhaseDelayMs = 125;
const pacedOutputCharacters = 65_536;
const pacedWarmupRounds = 5;

function pacedOutput(index: number, revision: number) {
  return `${toolId(index)} paced-revision-${revision}\n`.padEnd(
    pacedOutputCharacters,
    `${index}:${revision}:Synthetic paced Activity output. `,
  );
}

async function pacedRounds(page: Page, firstIndex: number, rounds: number) {
  for (let round = 0; round < rounds; round++) {
    const first = firstIndex + round * activeSessions;
    const indexes = Array.from({ length: activeSessions }, (_, offset) => first + offset);
    for (let phase = 0; phase < 4; phase++) {
      // This delay models delivery cadence; late phases never catch up in one browser task.
      await delay(pacedPhaseDelayMs);
      const events = indexes
        .filter((index) => phase !== 3 || index % 5 !== 0)
        .map((index) => {
          const identity = { name: tools[index % tools.length]!, toolCallId: toolId(index) };
          let data: ToolData;
          if (phase === 0) {
            data = {
              ...identity,
              phase: "start",
              args: { path: `/synthetic/activity/${index}.txt`, limit: 100 },
            };
          } else if (phase === 3) {
            data = {
              ...identity,
              phase: "result",
              result: { text: pacedOutput(index, phase), isError: index % 5 === 1 },
            };
          } else {
            data = {
              ...identity,
              phase: "update",
              partialResult: { text: pacedOutput(index, phase) },
            };
          }
          return event(index, phase + 1, data);
        });
      await emitBurst(page, events);
      await expectWindow(page, first + activeSessions - retainedRows, first + activeSessions - 1);
      const expected = indexes.map((index) => ({
        id: toolId(index),
        name: tools[index % tools.length]!,
        session: sessionKey(index),
        status: phase < 3 || index % 5 === 0 ? "running" : index % 5 === 1 ? "error" : "done",
        preview:
          phase === 0
            ? null
            : pacedOutput(index, phase === 3 && index % 5 === 0 ? 2 : phase).slice(0, 2_000),
      }));
      await page.waitForFunction(
        ({ selector, rows: expectedRows }) => {
          const rows = [...document.querySelectorAll(selector)].slice(-expectedRows.length);
          return (
            rows.length === expectedRows.length &&
            rows.every((row, index) => {
              const expectedRow = expectedRows[index]!;
              const facts = row.querySelector(".activity-entry__facts")?.textContent ?? "";
              return (
                facts.includes(expectedRow.id) &&
                facts.includes(expectedRow.session) &&
                row.querySelector(".activity-entry__tool")?.textContent === expectedRow.name &&
                row.classList.contains(`activity-entry--${expectedRow.status}`) &&
                (row.querySelector(".activity-entry__preview")?.textContent ?? null) ===
                  expectedRow.preview
              );
            })
          );
        },
        { selector: rowSelector, rows: expected },
      );
      await frames(page);
    }
    await verifyCapacity(page);
  }
  return {
    pacedRounds: rounds,
    pacedPhases: rounds * 4,
    minimumPhaseDelayMs: pacedPhaseDelayMs,
    minimumDeliveryDurationMs: rounds * 4 * pacedPhaseDelayMs,
    appendedTools: rounds * activeSessions,
    deliveredEvents: rounds * (activeSessions * 4 - activeSessions / 5),
    outputCharactersPerPreviewEvent: pacedOutputCharacters,
    deliveredOutputCharacters:
      rounds * (activeSessions * 3 - activeSessions / 5) * pacedOutputCharacters,
    activeSessions,
    retainedRows,
    checkedWindowCount: rounds * 4,
    checkedPreviewCount: rounds * 3 * activeSessions,
  };
}

async function preparePacedActivity(page: Page, gateway: MockGatewayControls) {
  await atCapacity(page, gateway);
  // Saturate the 100-row live window with the same 64 KiB payload shape before baseline GC.
  await pacedRounds(page, population, pacedWarmupRounds);
}

const fixture = { dataPage: "activity", route, fixtureOverrides: createDataActivityLiveFixture };

export const dataActivityLiveScenarios: readonly InteractionScenario[] = [
  ...[20, 80].map((rounds): InteractionScenario =>
    Object.assign({}, fixture, {
      id: `data-activity-live-paced-retention-${rounds}`,
      diagnostic:
        "Finite paced retention workload; intentional delivery delays and assertion overhead are included.",
      expected:
        `${rounds} paced rounds update 20 sessions through start, two previews and result; ` +
        "each phase retains the newest 100 rows and each update/result has its exact preview.",
      rowSelector,
      prepare: preparePacedActivity,
      run: async (page: Page) => {
        const result = await pacedRounds(
          page,
          population + pacedWarmupRounds * activeSessions,
          rounds,
        );
        return { ...result, warmupRounds: pacedWarmupRounds };
      },
    }),
  ),
  {
    ...fixture,
    id: "data-activity-live-first-render",
    expected:
      "A 2,800-event tool burst across 20 subscribed sessions renders the newest 100 tools.",
    rowSelector,
    prepare: prepareInitialBurst,
    run: async (page) => {
      await emitInitialBurst(page);
      await expectWindow(page, 900, 999);
      return verifyCapacity(page);
    },
  },
  {
    ...fixture,
    id: "data-activity-live-changed-first-render",
    expected:
      "A 2,800-event tool burst changes every terminal preview at its final retained code unit.",
    rowSelector,
    prepare: (page, gateway) => prepareInitialBurst(page, gateway, "changed"),
    run: async (page) => {
      await emitInitialBurst(page);
      await expectWindow(page, 900, 999);
      const capacity = await verifyCapacity(page);
      const terminalPreviews = await page
        .locator(`${rowSelector}:not(.activity-entry--running) .activity-entry__preview`)
        .allTextContents();
      if (terminalPreviews.length !== 80 || terminalPreviews.some((text) => !text.endsWith("!"))) {
        throw new Error("Activity Live did not replace every changed terminal preview");
      }
      return { ...capacity, changedTerminalPreviews: 80, changedCodeUnit: 2_000 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-unicode-first-render",
    expected:
      "A 2,800-event multilingual burst preserves 100 exact UTF-16 previews and opens its newest tool.",
    rowSelector,
    prepare: (page, gateway) => prepareInitialBurst(page, gateway, "unicode"),
    run: async (page) => {
      await emitInitialBurst(page);
      await expectWindow(page, 900, 999);
      const contents = await page.locator(streamSelector).evaluate((stream) => ({
        running: stream.querySelectorAll(".activity-entry--running").length,
        done: stream.querySelectorAll(".activity-entry--done").length,
        error: stream.querySelectorAll(".activity-entry--error").length,
        previews: [...stream.querySelectorAll(".activity-entry__preview")].map(
          (preview) => preview.textContent ?? "",
        ),
      }));
      if (
        contents.running !== 20 ||
        contents.done !== 60 ||
        contents.error !== 20 ||
        contents.previews.length !== 100 ||
        contents.previews.some((preview, index) => preview !== unicodePreview(900 + index))
      ) {
        throw new Error("Activity Live changed a multilingual preview or its retained window");
      }
      const newest = page.locator(rowSelector).last();
      await newest.locator("summary").click();
      await newest.locator(".activity-entry__preview").waitFor({ state: "visible" });
      await newest.locator(".activity-entry__preview").scrollIntoViewIfNeeded();
      return {
        populationTools: population,
        activeSessions,
        retainedRows,
        deliveredEvents: 2_800,
        previews1999Units: 50,
        previews2000Units: 50,
        loneSurrogatePreviews: 5,
        exactUtf16Previews: 100,
        visibleUnicodePreview: true,
      };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-search",
    expected: "Searching full Activity Live previews shows the ten matching retained tools.",
    prepare: atCapacity,
    run: async (page) => {
      await page.locator(".activity-live-search input[type=search]").fill("activity-live-needle");
      await expectCount(page, 10);
      await page
        .locator(rowSelector)
        .filter({ hasText: toolId(990) })
        .waitFor();
      return { retainedRows, matchingRows: 10 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-tool-filter",
    expected: "The Tool filter selects the 25 retained read calls without changing the feed.",
    prepare: atCapacity,
    run: async (page) => {
      await page.locator("#activity-live-filter-trigger").click();
      await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("read");
      await expectCount(page, 25);
      const names = await page.locator(`${rowSelector} .activity-entry__tool`).allTextContents();
      if (names.some((name) => name !== "read")) {
        throw new Error("Tool filter exposed a different tool");
      }
      return { retainedRows, matchingRows: 25 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-status-filter",
    expected: "Disabling Done and Error leaves the 20 currently running tools at capacity.",
    prepare: atCapacity,
    run: async (page) => {
      await page.getByRole("checkbox", { name: "Done", exact: true }).uncheck();
      await page.getByRole("checkbox", { name: "Error", exact: true }).uncheck();
      await expectCount(page, 20);
      if (await page.locator(`${rowSelector}:not(.activity-entry--running)`).count()) {
        throw new Error("Status filter exposed a terminal tool");
      }
      return { retainedRows, matchingRows: 20 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-tool-update",
    expected: "A running tool updates in place, keeps its disclosure open, and reaches Done.",
    rowSelector,
    prepare: async (page, gateway) => {
      await atCapacity(page, gateway);
      await page
        .locator(rowSelector)
        .filter({ hasText: toolId(950) })
        .locator("summary")
        .click();
    },
    run: async (page) => {
      const row = page.locator(rowSelector).filter({ hasText: toolId(950) });
      const retained = await row.elementHandle();
      if (!retained) {
        throw new Error("Missing running Activity row");
      }
      try {
        const identity = { name: "web_fetch", toolCallId: toolId(950) };
        const update = event(950, 3_001, {
          ...identity,
          phase: "update",
          partialResult: { text: "Updated synthetic Activity output." },
        });
        const result = event(950, 3_002, {
          ...identity,
          phase: "result",
          result: { text: "Completed synthetic Activity output.", isError: false },
        });
        await emitBurst(page, [update, result]);
        await row.getByText("Completed synthetic Activity output.", { exact: true }).waitFor();
        await row.and(page.locator(".activity-entry--done[open]")).waitFor();
        if (!(await retained.evaluate((element) => element.isConnected))) {
          throw new Error("Updating Activity replaced the retained disclosure");
        }
        await expectWindow(page, 900, 999);
        return { retainedRows, updatedRows: 1, deliveredEvents: 2, retainedDisclosure: true };
      } finally {
        await retained.dispose();
      }
    },
  },
  {
    ...fixture,
    id: "data-activity-live-append",
    expected: "A 56-event live burst adds 20 tools and evicts exactly the oldest 20 rows.",
    rowSelector,
    prepare: atCapacity,
    run: async (page) => {
      await emitBurst(page, toolEvents(1_000, 20));
      await expectWindow(page, 920, 1_019);
      return { deliveredEvents: 56, appendedTools: 20, retainedRows };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-expand-collapse",
    expected: "Expand all and Collapse all operate on all 100 retained native disclosures.",
    prepare: atCapacity,
    run: async (page) => {
      await page
        .locator(".activity-page")
        .getByRole("button", { name: "Expand all", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".activity-entry[open]").length === 100,
      );
      await page
        .locator(".activity-page")
        .getByRole("button", { name: "Collapse all", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".activity-entry[open]").length === 0,
      );
      return { retainedRows, expandedRows: 100, collapsedRows: 100 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-scroll",
    expected:
      "The live stream scrolls through 100 expanded 2,000-character previews to its last tool.",
    prepare: async (page, gateway) => {
      await atCapacity(page, gateway);
      await page
        .locator(".activity-page")
        .getByRole("button", { name: "Expand all", exact: true })
        .click();
      await page.waitForFunction(
        () => document.querySelectorAll(".activity-entry[open]").length === 100,
      );
      await page.locator(streamSelector).evaluate((stream) => {
        stream.scrollTop = 0;
      });
      await frames(page);
    },
    run: async (page) => {
      await page.locator(rowSelector).last().locator("summary").scrollIntoViewIfNeeded();
      await page.waitForFunction((selector) => {
        const stream = document.querySelector(selector);
        const summary = stream?.querySelector(".activity-entry:last-child summary");
        if (!stream || !summary) {
          return false;
        }
        const viewport = stream.getBoundingClientRect();
        const row = summary.getBoundingClientRect();
        return row.top >= viewport.top && row.bottom <= viewport.bottom;
      }, streamSelector);
      await expectWindow(page, 900, 999);
      return { retainedRows, expandedRows: 100, previewCharacters: 200_000 };
    },
  },
  {
    ...fixture,
    id: "data-activity-live-clear-reconnect",
    diagnostic:
      "Includes a same-auth Gateway restart/reconnect; lifecycle proof, not comparable interaction timing.",
    expected:
      "Clear preserves subscriptions; same-auth reconnect reacquires them and retains visible activity and expansion.",
    prepare: atCapacity,
    run: async (page, gateway) => {
      const actions = page.locator(".activity-page");
      await actions.getByRole("button", { name: "Expand all", exact: true }).click();
      await page.waitForFunction(
        () => document.querySelectorAll(".activity-entry[open]").length === 100,
      );
      await actions.getByRole("button", { name: "Clear", exact: true }).click();
      await expectCount(page, 0);
      await emitBurst(page, toolEvents(1_000, 1));
      await expectCount(page, 1);
      const afterClear = page
        .locator(`${rowSelector}:not([open])`)
        .filter({ hasText: toolId(1_000) });
      await afterClear.waitFor();
      await afterClear.locator("summary").click();
      await page
        .locator(rowSelector)
        .filter({ hasText: toolId(1_000) })
        .locator(".activity-entry__preview")
        .waitFor();
      const subscriptionCounts = await Promise.all(
        Array.from({ length: activeSessions }, (_, index) =>
          gateway
            .getRequests("sessions.messages.subscribe", { key: sessionKey(index) })
            .then((requests) => requests.length),
        ),
      );
      await reconnectMockGateway(page, gateway, "data-activity-live-restarted");
      await Promise.all(
        subscriptionCounts.map((after, index) =>
          gateway.waitForRequest("sessions.messages.subscribe", {
            after,
            match: { key: sessionKey(index) },
          }),
        ),
      );
      await expectCount(page, 1);
      await page
        .locator(`${rowSelector}[open]`)
        .filter({ hasText: toolId(1_000) })
        .waitFor();
      await emitBurst(page, toolEvents(1_001, 1));
      await expectCount(page, 2);
      const afterReconnect = page
        .locator(`${rowSelector}:not([open])`)
        .filter({ hasText: toolId(1_001) });
      await afterReconnect.waitFor();
      await afterReconnect.locator("summary").click();
      await page
        .locator(rowSelector)
        .filter({ hasText: toolId(1_001) })
        .locator(".activity-entry__preview")
        .waitFor();
      return {
        retainedRows: 2,
        activeSessions,
        clearResumed: true,
        reconnectResumed: true,
        reconnectRetainedExpanded: true,
      };
    },
  },
];

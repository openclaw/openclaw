import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { afterWorkboardUpdate as settle } from "../../test/settle.ts";
import { mountPage } from "./workboard-page.test-support.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function mountAutomation(
  boards: { id: string; automationJobId?: string }[],
  loadJob: (params: unknown) => unknown,
  cards: ReturnType<typeof createWorkboardCard>[] = [],
) {
  const page = mountPage({ boardId: "planning" });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return { cards, boards };
    }
    return method === "cron.get" ? loadJob(params) : request(method);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    heading: () => page.container.querySelector(".workboard-heading__automation-name"),
    expectText: (text: string) => settle(() => expect(page.container.textContent).toContain(text)),
  };
}

it("renders an event-backed board without assuming a stream command or timed next run", async () => {
  const page = mountAutomation([{ id: "planning", automationJobId: "job-events" }], () => ({
    ...automationJob("Review incoming events"),
    schedule: { kind: "event", source: "mcp-events", options: { name: "comment.created" } },
    state: {},
  }));
  await settle(() => expect(page.heading()?.textContent).toContain("Review incoming events"));
  const info = page.container.querySelector(".workboard-automation-info");
  expect(info?.textContent).toContain("Event: mcp-events");
  expect(info?.textContent).toContain("Waiting for event");
  expect(info?.textContent).not.toContain("Not scheduled");
});

it("omits the automation link when none is attached", async () => {
  const page = mountAutomation([{ id: "planning" }], () => automationJob("Planning job"));
  await settle(() => expect(page.workboard.state.loaded).toBe(true));
  expect(page.heading()).toBeNull();
});

it("refreshes active automation on cron events and defers hidden updates until return", async () => {
  const earlier = createDeferred<ReturnType<typeof automationJob>>();
  let loads = 0;
  const page = mountAutomation([{ id: "planning", automationJobId: "job-planning" }], () => {
    loads += 1;
    return loads === 1 ? earlier.promise : automationJob(`Revision ${loads}`);
  });
  await settle(() => expect(loads).toBe(1));
  page.fixture.emit("cron", { jobId: "other-job", action: "updated" });
  await settle(() => expect(loads).toBe(1));
  page.fixture.emit("cron", { jobId: "job-planning", action: "updated" });
  await page.expectText("Revision 2");
  expect(page.heading()).toBeInstanceOf(HTMLAnchorElement);
  expect(page.heading()?.getAttribute("href")).toBe("/automations?job=job-planning");
  earlier.resolve(automationJob("Stale revision"));
  await settle(() => expect(page.container.textContent).not.toContain("Stale revision"));
  page.present(false);
  await settle(() => expect(page.heading()).toBeNull());
  page.fixture.emit("cron", { jobId: "job-planning", action: "finished" });
  await settle(() => expect(loads).toBe(2));
  page.present(true);
  await page.expectText("Revision 3");
  page.dispose();
  page.fixture.emit("cron", { jobId: "job-planning", action: "updated" });
  await settle(() => expect(loads).toBe(3));
});

it("shares board and detail automation loading and ignores an earlier visit's late response", async () => {
  const card = createWorkboardCard({ metadata: { automation: { boardId: "planning" } } });
  const earlier = createDeferred<ReturnType<typeof automationJob>>();
  const current = createDeferred<ReturnType<typeof automationJob>>();
  let planningLoads = 0;
  const page = mountAutomation(
    ["planning", "operations"].map((id) => ({ id, automationJobId: `job-${id}` })),
    (params) => {
      if (!isRecord(params) || params.id !== "job-planning") {
        return automationJob("Operations job");
      }
      return ++planningLoads === 1 ? earlier.promise : current.promise;
    },
    [card],
  );
  await settle(() => expect(planningLoads).toBe(1));
  page.workboard.state.detailCardId = card.id;
  page.workboard.notify();
  await settle(() => expect(page.container.querySelector(".workboard-detail")).not.toBeNull());
  expect(planningLoads).toBe(1);
  page.navigate("operations");
  await page.expectText("Operations job");
  page.navigate("planning");
  await settle(() => expect(planningLoads).toBe(2));
  page.workboard.state.detailCardId = card.id;
  page.workboard.notify();
  const expectCurrent = () => {
    expect(page.heading()?.textContent).toContain("Current");
    expect(page.container.querySelector(".workboard-detail")?.textContent).toContain("Current");
  };
  current.resolve(automationJob("Current"));
  await settle(expectCurrent);
  earlier.resolve(automationJob("Stale planning job"));
  await settle(() => expect(page.container.textContent).not.toContain("Stale planning job"));
  expectCurrent();
  expect(planningLoads).toBe(2);
});

const automationJob = (name: string) => ({
  name,
  enabled: true,
  updatedAtMs: 2,
  schedule: { kind: "every", everyMs: 86400000 },
  state: { nextRunAtMs: 100000 },
});

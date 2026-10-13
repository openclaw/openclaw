import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

function mountAutomation(
  boards: { id: string; automationJobId?: string }[],
  loadJob: (params: unknown) => unknown,
  cards: ReturnType<typeof createWorkboardCard>[] = [],
) {
  const page = mountPage({ boardId: "planning" });
  const request = expectDefined(page.request.getMockImplementation(), "request implementation");
  page.request.mockImplementation(async (method, params) => {
    if (method === "workboard.cards.list") {
      return {
        cards,
        boards: boards.map((board) => ({
          total: cards.length,
          active: cards.length,
          archived: 0,
          byStatus: {},
          ...board,
        })),
      };
    }
    return method === "cron.get" ? loadJob(params) : request(method);
  });
  page.fixture.connection.connected = true;
  page.fixture.notify();
  return {
    ...page,
    heading: () => page.container.querySelector(".workboard-heading__automation-name"),
  };
}

describe("Workboard automation lifecycle", () => {
  it("omits the automation link when none is attached", async () => {
    const page = mountAutomation([{ id: "planning" }], () =>
      automationJob("job-planning", "Planning job"),
    );
    await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
    expect(page.heading()).toBeNull();
  });

  it("refreshes active automation on cron events and defers hidden updates until return", async () => {
    const earlier = createDeferred<ReturnType<typeof automationJob>>();
    let loads = 0;
    const page = mountAutomation([{ id: "planning", automationJobId: "job-planning" }], () => {
      loads += 1;
      return loads === 1 ? earlier.promise : automationJob("job-planning", `Revision ${loads}`);
    });
    await vi.waitFor(() => expect(loads).toBe(1));
    page.fixture.emit("cron", { jobId: "other-job", action: "updated" });
    await Promise.resolve();
    expect(loads).toBe(1);
    page.fixture.emit("cron", { jobId: "job-planning", action: "updated" });
    await vi.waitFor(() => expect(page.container.textContent).toContain("Revision 2"));
    expect(page.heading()).toBeInstanceOf(HTMLAnchorElement);
    expect(page.heading()?.getAttribute("href")).toBe("/automations?job=job-planning");
    earlier.resolve(automationJob("job-planning", "Stale revision"));
    await earlier.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(page.container.textContent).not.toContain("Stale revision");
    page.present(false);
    await vi.waitFor(() => expect(page.heading()).toBeNull());
    page.fixture.emit("cron", { jobId: "job-planning", action: "finished" });
    await Promise.resolve();
    expect(loads).toBe(2);
    page.present(true);
    await vi.waitFor(() => expect(page.container.textContent).toContain("Revision 3"));
    page.dispose();
    page.fixture.emit("cron", { jobId: "job-planning", action: "updated" });
    await Promise.resolve();
    expect(loads).toBe(3);
  });

  it("shares board and detail automation loading and ignores an earlier visit's late response", async () => {
    const card = createWorkboardCard({
      id: "planning-card",
      metadata: { automation: { boardId: "planning" } },
    });
    const earlier = createDeferred<ReturnType<typeof automationJob>>();
    const current = createDeferred<ReturnType<typeof automationJob>>();
    let planningLoads = 0;
    const page = mountAutomation(
      ["planning", "operations"].map((id) => ({ id, automationJobId: `job-${id}` })),
      (params) => {
        if (
          params &&
          typeof params === "object" &&
          "id" in params &&
          params.id === "job-planning"
        ) {
          planningLoads += 1;
          return planningLoads === 1 ? earlier.promise : current.promise;
        }
        return automationJob("job-operations", "Operations job");
      },
      [card],
    );
    await vi.waitFor(() => expect(planningLoads).toBe(1));
    page.workboard.state.detailCardId = card.id;
    page.workboard.notify();
    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-detail")).not.toBeNull(),
    );
    expect(planningLoads).toBe(1);
    page.navigate("operations");
    await vi.waitFor(() => expect(page.container.textContent).toContain("Operations job"));
    page.navigate("planning");
    await vi.waitFor(() => expect(planningLoads).toBe(2));
    page.workboard.state.detailCardId = card.id;
    page.workboard.notify();
    current.resolve(automationJob("job-planning", "Current planning job"));
    await vi.waitFor(() => {
      expect(page.heading()?.textContent).toContain("Current planning job");
      expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
        "Current planning job",
      );
    });
    earlier.resolve(automationJob("job-planning", "Stale planning job"));
    await earlier.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(page.container.textContent).not.toContain("Stale planning job");
    expect(page.heading()?.textContent).toContain("Current planning job");
    expect(page.container.querySelector(".workboard-detail")?.textContent).toContain(
      "Current planning job",
    );
    expect(planningLoads).toBe(2);
  });
});

function automationJob(id: string, name: string) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 2,
    schedule: { kind: "every", everyMs: 86400000 },
    state: { nextRunAtMs: 100000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Review planning" },
  };
}

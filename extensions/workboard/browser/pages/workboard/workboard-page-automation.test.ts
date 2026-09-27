import "../../test/dom.setup.ts";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { mountPage } from "./workboard-page.test-support.ts";

describe("Workboard automation lifecycle", () => {
  it.each(["job-planning", undefined])(
    "links a board's automation only when attached: %s",
    async (automationJobId) => {
      const page = mountPage({ boardId: "planning" });
      const boards = [
        {
          id: "planning",
          total: 0,
          active: 0,
          archived: 0,
          byStatus: {},
          ...(automationJobId ? { automationJobId } : {}),
        },
      ];
      const request = expectDefined(page.request.getMockImplementation(), "request implementation");
      page.request.mockImplementation(async (method) => {
        if (method === "workboard.cards.list") {
          return { cards: [], boards };
        }
        if (method === "cron.get") {
          return automationJob("job-planning", "Planning job");
        }
        return request(method);
      });
      page.fixture.connection.connected = true;
      page.fixture.notify();
      await vi.waitFor(() => expect(page.workboard.state.loaded).toBe(true));
      if (automationJobId) {
        await vi.waitFor(() =>
          expect(
            page.container
              .querySelector("a.workboard-heading__automation-name")
              ?.getAttribute("href"),
          ).toBe("/automations?job=job-planning"),
        );
      } else {
        expect(page.container.querySelector(".workboard-heading__automation-name")).toBeNull();
      }
    },
  );

  it("refreshes active automation on cron events and defers hidden updates until return", async () => {
    const page = mountPage({ boardId: "planning" });
    const earlier = createDeferred<ReturnType<typeof automationJob>>();
    let loads = 0;
    const request = expectDefined(page.request.getMockImplementation(), "request implementation");
    page.request.mockImplementation(async (method) => {
      if (method === "workboard.cards.list") {
        return {
          cards: [],
          boards: [
            {
              id: "planning",
              total: 0,
              active: 0,
              archived: 0,
              byStatus: {},
              automationJobId: "job-planning",
            },
          ],
        };
      }
      if (method === "cron.get") {
        loads += 1;
        return loads === 1 ? earlier.promise : automationJob("job-planning", `Revision ${loads}`);
      }
      return request(method);
    });
    page.fixture.connection.connected = true;
    page.fixture.notify();
    await vi.waitFor(() => expect(loads).toBe(1));
    page.fixture.emit("cron", { jobId: "other-job", action: "updated" });
    await Promise.resolve();
    expect(loads).toBe(1);
    page.fixture.emit("cron", { jobId: "job-planning", action: "updated" });
    await vi.waitFor(() => expect(page.container.textContent).toContain("Revision 2"));
    earlier.resolve(automationJob("job-planning", "Stale revision"));
    await earlier.promise;
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(page.container.textContent).not.toContain("Stale revision");
    page.present(false);
    await vi.waitFor(() =>
      expect(page.container.querySelector(".workboard-heading__automation-name")).toBeNull(),
    );
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
    const page = mountPage({ boardId: "planning" });
    const card = createWorkboardCard({
      id: "planning-card",
      metadata: { automation: { boardId: "planning" } },
    });
    const boards = ["planning", "operations"].map((id) => ({
      id,
      total: 1,
      active: 1,
      archived: 0,
      byStatus: {},
      automationJobId: `job-${id}`,
    }));
    const earlier = createDeferred<ReturnType<typeof automationJob>>();
    const current = createDeferred<ReturnType<typeof automationJob>>();
    let planningLoads = 0;
    const request = expectDefined(page.request.getMockImplementation(), "request implementation");
    page.request.mockImplementation(async (method, ...args) => {
      if (method === "workboard.cards.list") {
        return { cards: [card], boards };
      }
      if (method === "cron.get") {
        const params: unknown = args[0];
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
      }
      return request(method);
    });
    page.fixture.connection.connected = true;
    page.fixture.notify();
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
      expect(
        page.container.querySelector(".workboard-heading__automation-name")?.textContent,
      ).toContain("Current planning job");
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
    expect(
      page.container.querySelector(".workboard-heading__automation-name")?.textContent,
    ).toContain("Current planning job");
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

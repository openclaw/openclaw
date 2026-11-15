import "../../test/dom.setup.ts";
import { expect, it, vi } from "vitest";
import { createWorkboardCard } from "../../lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "../../test/host.setup.ts";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardView, requireButton } from "./view.test-support.ts";

it("reports readiness updates and pending planning, preserves failure counts, and redacts the first cause", async () => {
  const card = createWorkboardCard({ status: "triage", title: "Plan release rollout" });
  const first = createWorkboardCard({
    id: "first",
    title: "Review release",
    status: "ready",
    metadata: { automation: { scheduledAt: 1 } },
  });
  const second = createWorkboardCard({ id: "second", title: "Second failure", status: "ready" });
  let recovered = false;
  const request = vi.fn(async (method: string) => {
    if (method === "workboard.cards.dispatch") {
      return {
        started: [],
        promoted: recovered ? [] : [first],
        blocked: [],
        reclaimed: [],
        orchestrated: recovered ? [] : [card],
        startFailures: recovered
          ? []
          : [
              { cardId: "first", title: "Review release", error: "Refused fixture-secret" },
              { cardId: "second", title: "Second failure", error: "Another refusal" },
            ],
      };
    }
    return { cards: [card, first, second], boards: [], statuses: ["triage", "ready", "scheduled"] };
  });
  vi.mocked(workboardTestHost().host.redact).mockImplementation((text) =>
    text.replaceAll("fixture-secret", "[redacted]"),
  );
  const { state, container, renderView } = createWorkboardView({
    client: { request },
    connected: true,
    canWrite: true,
  });
  state.cards = [card, { ...first, status: "scheduled" }, second];
  renderView();
  requireButton(container, "Start agents").click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(state.dispatching).toBe(false));
  renderView();
  await waitForFast(() =>
    expect(container.querySelector(".toast .message")?.textContent).toContain(
      "Failed to start: 2.",
    ),
  );
  const text = container.querySelector(".toast .message")?.textContent;
  expect.soft(text).toContain("Readiness updated: 1");
  expect.soft(text).toContain("marked for planning: 1");
  expect.soft(text).toContain("First start failure: Review release: Refused [redacted]");
  expect(text).not.toContain("organized");
  expect(text).not.toContain("fixture-secret");
  expect(text).not.toContain("Second failure");
  recovered = true;
  requireButton(container, "Start agents").click();
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4));
  await vi.waitFor(() => expect(state.dispatching).toBe(false));
  renderView();
  await waitForFast(() =>
    expect(container.querySelector(".toast .message")?.textContent).toBe("No cards were started."),
  );
  expect(container.querySelector(".toast .message")?.textContent).not.toContain("Refused");
});

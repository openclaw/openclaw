import "./test/dom.setup.ts";
import { flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
import { workboardTestHost } from "./test/host.setup.ts";
import { createViewContext } from "./test/host.ts";
import { createWorkboardWidget } from "./widgets.tsx";

it("renders a board widget with that board's columns and its Other statuses lane", async () => {
  const fixture = workboardTestHost();
  fixture.connection.connected = true;
  const card = (id: string, status: "blocked" | "review" | "done") =>
    createWorkboardCard({
      id,
      title: `${id} card`,
      status,
      metadata: { automation: { boardId: "overview" } },
    });
  fixture.host.request = vi.fn(async () => ({
    cards: [card("ask", "blocked"), card("check", "review"), card("ship", "done")],
    boards: [
      {
        id: "overview",
        total: 3,
        active: 3,
        archived: 0,
        byStatus: {},
        columns: {
          visible: ["blocked", "done"],
          labels: { blocked: "Needs you", review: "Checking" },
        },
      },
    ],
  })) as typeof fixture.host.request;
  const container = document.body.appendChild(document.createElement("div"));
  const widget = { name: "Board", props: { boardId: "overview" } };
  const context = createViewContext(
    fixture.host,
    { sessionKey: "main", widget, canMutate: true, canGrant: true },
    true,
  );
  const mounted = createWorkboardWidget(fixture.host, "board")(container, context);
  onTestFinished(() => container.remove());
  onTestFinished(() => mounted?.dispose?.());
  await vi.waitFor(() => expect(container.textContent).toContain("check card"));
  flush();
  expect(
    Array.from(container.querySelectorAll(".workboard-column h2"), (heading) =>
      heading.textContent?.trim(),
    ),
  ).toEqual(["Needs you", "Done", "Other statuses"]);
  expect(container.querySelector(".workboard-column--other")?.textContent).toContain("Checking");
});

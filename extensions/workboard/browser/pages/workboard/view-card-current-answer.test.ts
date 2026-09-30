import "../../test/dom.setup.ts";
import { render } from "lit";
import { expect, it } from "vitest";
import type { WorkboardCard } from "../../lib/workboard/types.ts";
import { renderCurrentAnswer } from "./view-card-detail-records.ts";

it("renders one canonical answer with stable needs-user and provenance links", () => {
  const card = {
    id: "card-1",
    title: "Wedding preview",
    status: "review",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 10,
    sourceUrl: "https://chat.example.test/thread/1",
    metadata: {
      comments: [{ id: "old", body: "Stale handoff", createdAt: 1 }],
      automation: {
        handoff: {
          summary: "Current verified answer",
          updatedAt: 10,
          needsUser: "Approve phone UAT",
          previewUrl: "https://preview.example.test/result",
          verifiedAt: 9,
          deliveryStatus: "failed",
        },
      },
    },
  } satisfies WorkboardCard;
  const container = document.createElement("div");
  render(renderCurrentAnswer(card, "agent:cody:session-1"), container);

  expect(container.textContent).toContain("Current verified answer");
  expect(container.textContent).toContain("Approve phone UAT");
  expect(container.textContent).toContain("failed");
  expect(container.textContent).not.toContain("Stale handoff");
  expect([...container.querySelectorAll("a")].map((link) => link.href)).toEqual(
    expect.arrayContaining([
      "https://preview.example.test/result",
      "https://chat.example.test/thread/1",
    ]),
  );
});

it("surfaces a newer legacy failure update instead of the stale completion summary", () => {
  const card = {
    id: "23233698-wedding",
    title: "Wedding preview",
    status: "done",
    priority: "normal",
    labels: [],
    position: 1000,
    createdAt: 1,
    updatedAt: 20,
    completedAt: 10,
    metadata: {
      automation: { summary: "Preview completed successfully." },
      comments: [{ id: "feedback", body: "Preview opens Hocking Hills.", createdAt: 20 }],
    },
  } satisfies WorkboardCard;
  const container = document.createElement("div");
  render(renderCurrentAnswer(card), container);

  expect(container.textContent).toContain("Preview opens Hocking Hills.");
  expect(container.textContent).not.toContain("Preview completed successfully.");
  expect(container.textContent).not.toContain("Needs you");
  expect(container.querySelectorAll("a")).toHaveLength(0);
});

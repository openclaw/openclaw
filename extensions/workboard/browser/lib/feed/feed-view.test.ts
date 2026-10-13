import { describe, expect, it } from "vitest";
import type { WorkboardCard } from "../workboard/types.ts";
import { buildFeedView, toFeedItem } from "./feed-view.ts";

const NOW = new Date(2026, 9, 13, 15, 0, 0).getTime();
const HOUR = 60 * 60 * 1000;

function card(overrides: Partial<WorkboardCard> & { id: string }): WorkboardCard {
  return {
    title: overrides.id,
    status: "todo",
    priority: "normal",
    labels: [],
    position: 1,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 5 * HOUR,
    ...overrides,
  };
}

describe("feed view", () => {
  it("orders open cards by unread reply, then priority, then newest", () => {
    const view = buildFeedView(
      [
        card({ id: "old-normal", createdAt: NOW - 9 * HOUR }),
        card({ id: "new-normal", createdAt: NOW - HOUR }),
        card({ id: "urgent", priority: "urgent", createdAt: NOW - 8 * HOUR }),
        card({
          id: "replied",
          priority: "low",
          metadata: {
            feed: { ackedAt: NOW - 3 * HOUR },
            comments: [
              { id: "c1", body: "ok", createdAt: NOW - 3 * HOUR, author: { kind: "owner" } },
              { id: "c2", body: "done?", createdAt: NOW - 2 * HOUR, author: { kind: "agent" } },
            ],
          },
        }),
      ],
      NOW,
    );
    expect(view.open.map((item) => item.card.id)).toEqual([
      "replied",
      "urgent",
      "new-normal",
      "old-normal",
    ]);
    expect(view.open[0]?.unread).toBe(true);
  });

  it("moves acked and done cards to handled today, and drops older ones", () => {
    const view = buildFeedView(
      [
        card({ id: "acked", metadata: { feed: { ackedAt: NOW - HOUR } } }),
        card({ id: "done", status: "done", completedAt: NOW - 2 * HOUR }),
        card({ id: "acked-last-week", metadata: { feed: { ackedAt: NOW - 7 * 24 * HOUR } } }),
        // An owner reply after the agent's comment keeps the card handled.
        card({
          id: "answered",
          metadata: {
            feed: { ackedAt: NOW - 30 * 60 * 1000 },
            comments: [
              { id: "a", body: "?", createdAt: NOW - HOUR, author: { kind: "agent", id: "x" } },
            ],
          },
        }),
      ],
      NOW,
    );
    expect(view.open).toEqual([]);
    expect(view.handled.map((item) => item.card.id)).toEqual(["answered", "acked", "done"]);
  });

  it("derives tag, title and summary for cards without feed metadata", () => {
    const item = toFeedItem(
      card({
        id: "plain",
        title: "Email: send the renewal quote",
        labels: ["send"],
        notes: "\nDraft is in Gmail drafts.\n\n- Price: 12k\n- Due Friday",
      }),
    );
    expect(item).toMatchObject({
      tag: "EMAIL · TO SEND",
      title: "Send the renewal quote",
      summary: "Draft is in Gmail drafts.",
      body: "- Price: 12k\n- Due Friday",
      icon: "mail",
    });
  });

  it("uses the clicked action for the handled line", () => {
    const item = toFeedItem(
      card({
        id: "sent",
        title: "Dana is waiting on the Q3 proposal",
        metadata: {
          feed: {
            tag: "EMAIL · DRAFT",
            ackedAt: NOW,
            ackedAction: "send",
            actions: [{ id: "send", label: "Send", message: "send it", doneLabel: "Sent" }],
          },
        },
      }),
    );
    expect(item.doneLabel).toBe("Sent: Dana is waiting on the Q3 proposal");
    expect(item.title).toBe("Dana is waiting on the Q3 proposal");
  });

  it("does not claim the primary outcome after a reply or a plain Done", () => {
    const feed = {
      doneLabel: "Shared the Q3 summary",
      actions: [{ id: "share", label: "Share", message: "share it", style: "primary" as const }],
    };
    const replied = toFeedItem(
      card({
        id: "replied",
        title: "Q3 revenue landed",
        metadata: {
          feed: { ...feed, ackedAt: NOW },
          comments: [{ id: "c", body: "no bars", createdAt: NOW - 20, author: { kind: "owner" } }],
        },
      }),
    );
    expect(replied.doneLabel).toBe("Replied: Q3 revenue landed");
    const dismissed = toFeedItem(
      card({
        id: "dismissed",
        title: "Q3 revenue landed",
        metadata: { feed: { ...feed, ackedAt: NOW } },
      }),
    );
    expect(dismissed.doneLabel).toBe("Q3 revenue landed");
    const shared = toFeedItem(
      card({
        id: "shared",
        title: "Q3 revenue landed",
        metadata: { feed: { ...feed, ackedAt: NOW, ackedAction: "share" } },
      }),
    );
    expect(shared.doneLabel).toBe("Shared the Q3 summary");
  });
});

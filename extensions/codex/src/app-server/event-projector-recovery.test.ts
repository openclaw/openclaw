import { describe, expect, it } from "vitest";
import { reconcileCodexRecoveredAssistantItems } from "./event-projector-recovery.js";
import { readItem } from "./event-projector-values.js";

const message = (id: string, text = "same", phase = "commentary") =>
  readItem({ id, type: "agentMessage", text, phase })!;

describe("recovered assistant item identities", () => {
  it("preserves canonical identities around a missing commentary item", () => {
    const items = reconcileCodexRecoveredAssistantItems({
      observed: [message("canonical-before", "before"), message("canonical-after", "after")],
      items: [
        message("item-1", "before"),
        message("item-2", "missing"),
        message("item-3", "after"),
      ],
    });
    expect(items.map((item) => item.id)).toEqual(["canonical-before", "item-2", "canonical-after"]);
  });

  it("preserves distinct identical messages when their complete ordering is known", () => {
    const items = [message("item-1"), message("item-2"), message("item-3")];
    expect(
      reconcileCodexRecoveredAssistantItems({ observed: [], items }).map((item) => item.id),
    ).toEqual(["item-1", "item-2", "item-3"]);
    expect(
      reconcileCodexRecoveredAssistantItems({
        observed: [message("first"), message("second"), message("third")],
        items,
      }).map((item) => item.id),
    ).toEqual(["first", "second", "third"]);
  });

  it("rejects an ambiguous partial sequence of identical messages", () => {
    expect(() =>
      reconcileCodexRecoveredAssistantItems({
        observed: [message("first"), message("last")],
        items: [message("item-1"), message("item-2"), message("item-3")],
      }),
    ).toThrow("ambiguous");
  });

  it("uses stable native IDs as anchors without text-set deduplication", () => {
    expect(
      reconcileCodexRecoveredAssistantItems({
        observed: [message("item-1"), message("item-3")],
        items: [message("item-1"), message("item-2"), message("item-3")],
      }).map((item) => item.id),
    ).toEqual(["item-1", "item-2", "item-3"]);
  });

  it("retains the canonical identity of the terminal summary's last final answer", () => {
    expect(
      reconcileCodexRecoveredAssistantItems({
        observed: [message("earlier-final", "answer", "final_answer")],
        terminalAssistant: message("canonical-final", "answer", "final_answer"),
        items: [
          message("item-1", "answer", "final_answer"),
          message("item-2", "answer", "final_answer"),
        ],
      }).map((item) => item.id),
    ).toEqual(["earlier-final", "canonical-final"]);
  });

  it("rejects changed or reordered observed content", () => {
    expect(() =>
      reconcileCodexRecoveredAssistantItems({
        observed: [message("canonical", "original")],
        items: [message("item-1", "different")],
      }),
    ).toThrow("ambiguous");
    expect(() =>
      reconcileCodexRecoveredAssistantItems({
        observed: [message("first", "first"), message("last", "last")],
        items: [message("item-1", "last"), message("item-2", "first")],
      }),
    ).toThrow("ambiguous");
  });

  it("does not replay an async delivery without its already observed canonical identity", () => {
    const item = { ...message("item-1"), delivery: "async" as const };
    expect(() => reconcileCodexRecoveredAssistantItems({ observed: [], items: [item] })).toThrow(
      "async delivery",
    );
    expect(
      reconcileCodexRecoveredAssistantItems({
        observed: [{ ...item, id: "canonical-async" }],
        items: [item],
      })[0]?.id,
    ).toBe("canonical-async");
  });
});

import { describe, expect, it } from "vitest";
import { snapshotAssistantMessage } from "./embedded-agent-subscribe.assistant-snapshot.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";

describe("assistant snapshot ownership", () => {
  it("preserves native getter, subtype, alias and clone-failure behavior", () => {
    const source = makeAssistantMessageFixture({ content: [{ type: "text", text: "original" }] });
    let reads = 0;
    Object.defineProperty(source.content[0], "text", {
      enumerable: true,
      get: () => `read-${++reads}`,
    });
    const shared = { date: new Date(0), bytes: new Uint8Array([1, 2]) };
    Object.assign(source, { native: { first: shared, second: shared } });
    const expected = structuredClone(source);
    expect(reads).toBe(1);
    reads = 0;
    const { snapshot } = snapshotAssistantMessage(source);
    expect(reads).toBe(1);
    expect(snapshot).toEqual(expected);
    const unsupported = Object.assign(source, { callback: () => {} });
    expect(() => snapshotAssistantMessage(unsupported)).toThrow();
  });

  it("shares only exact-event captured values despite source or caller mutations", () => {
    const source = makeAssistantMessageFixture({
      content: [{ type: "thinking", thinking: "captured" }],
    });
    const first = snapshotAssistantMessage(source);
    first.snapshot.content[0] = { type: "thinking", thinking: "caller changed" };
    expect(snapshotAssistantMessage(source, first.reasoning).snapshot.content).toEqual([
      { type: "thinking", thinking: "captured" },
    ]);
    source.content[0] = { type: "thinking", thinking: "source changed" };
    expect(snapshotAssistantMessage(source, first.reasoning).snapshot.content).toEqual([
      { type: "thinking", thinking: "source changed" },
    ]);
    const other = makeAssistantMessageFixture({
      content: [{ type: "text", text: "other event" }],
    });
    expect(snapshotAssistantMessage(other, first.reasoning).snapshot.content).toEqual(
      other.content,
    );
  });
});

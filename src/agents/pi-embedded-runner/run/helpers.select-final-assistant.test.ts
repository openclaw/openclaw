import { describe, expect, it } from "vitest";
import { selectFinalAssistantForPayloads } from "./helpers.js";

type SnapshotMessage = {
  role: string;
  text: string;
};

describe("selectFinalAssistantForPayloads", () => {
  it("returns the current-turn assistant when one exists after the latest user", () => {
    const result = selectFinalAssistantForPayloads<SnapshotMessage>([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old reply" },
      { role: "user", text: "new request" },
      { role: "assistant", text: "replacement reply" },
    ]);

    expect(result).toEqual({ role: "assistant", text: "replacement reply" });
  });

  it("returns undefined when the current-turn assistant was blocked", () => {
    const result = selectFinalAssistantForPayloads<SnapshotMessage>([
      { role: "user", text: "old request" },
      { role: "assistant", text: "old reply" },
      { role: "user", text: "new request" },
    ]);

    expect(result).toBeUndefined();
  });

  it("falls back to the latest assistant when no user message exists", () => {
    const result = selectFinalAssistantForPayloads<SnapshotMessage>([
      { role: "assistant", text: "first reply" },
      { role: "assistant", text: "latest reply" },
    ]);

    expect(result).toEqual({ role: "assistant", text: "latest reply" });
  });
});

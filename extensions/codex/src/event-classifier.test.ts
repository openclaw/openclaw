// Tests for the Codex event classifier.
//
// Event shapes below mirror the emissions in
// extensions/codex/src/app-server/event-projector.ts. If an emission site adds
// a new field or renames one, update the fixtures here alongside the source.

import { describe, expect, it } from "vitest";
import { classifyCodexEvent, CODEX_STREAM_CLASSIFIERS, isCodexStream } from "./event-classifier.js";

describe("classifyCodexEvent", () => {
  describe("codex_app_server.item", () => {
    it("classifies agentMessage on turn end as final_reply", () => {
      expect(
        classifyCodexEvent(
          {
            stream: "codex_app_server.item",
            data: {
              type: "agentMessage",
              phase: "completed",
              text: "All done.",
              itemId: "item-1",
            },
          },
          { isTurnEnd: true },
        ),
      ).toBe("final_reply");
    });

    it("classifies intermediate agentMessage as progress", () => {
      expect(
        classifyCodexEvent(
          {
            stream: "codex_app_server.item",
            data: {
              type: "agentMessage",
              phase: "completed",
              text: "Let me try another approach.",
              itemId: "item-1",
            },
          },
          { isTurnEnd: false },
        ),
      ).toBe("progress");
    });

    it("treats agentMessage start phase as progress even if turnEnd is true", () => {
      // Edge case: turn-end context fires on a start phase (shouldn't happen in
      // practice; defensive). progress is the correct safe downgrade here —
      // the text isn't a "final" assistant reply yet.
      expect(
        classifyCodexEvent(
          {
            stream: "codex_app_server.item",
            data: { type: "agentMessage", phase: "started", itemId: "item-1" },
          },
          { isTurnEnd: true },
        ),
      ).toBe("progress");
    });

    it("promotes agentMessage to blocked when text asks for user input", () => {
      expect(
        classifyCodexEvent(
          {
            stream: "codex_app_server.item",
            data: {
              type: "agentMessage",
              phase: "completed",
              text: "I'm blocked — need your input to continue.",
              itemId: "item-2",
            },
          },
          { isTurnEnd: true },
        ),
      ).toBe("blocked");
    });

    it("classifies plan items as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.item",
          data: { type: "plan", phase: "completed", itemId: "item-3" },
        }),
      ).toBe("internal_narration");
    });

    it("classifies reasoning items as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.item",
          data: { type: "reasoning", phase: "completed", itemId: "item-4" },
        }),
      ).toBe("internal_narration");
    });

    it("classifies tool_call items as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.item",
          data: { type: "tool_call", phase: "started", itemId: "item-5" },
        }),
      ).toBe("internal_narration");
    });

    it("classifies contextCompaction items as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.item",
          data: { type: "contextCompaction", phase: "started", itemId: "item-6" },
        }),
      ).toBe("internal_narration");
    });

    it("handles missing data defensively", () => {
      expect(classifyCodexEvent({ stream: "codex_app_server.item", data: undefined })).toBe(
        "internal_narration",
      );
    });

    it("handles nested item shape (future compat)", () => {
      expect(
        classifyCodexEvent(
          {
            stream: "codex_app_server.item",
            data: {
              phase: "completed",
              item: { type: "agentMessage", text: "Shipping now." },
            },
          },
          { isTurnEnd: true },
        ),
      ).toBe("final_reply");
    });
  });

  describe("codex_app_server.guardian", () => {
    it("always classifies as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.guardian",
          data: { method: "some/review" },
        }),
      ).toBe("internal_narration");
    });
  });

  describe("codex_app_server.tool", () => {
    it("always classifies as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.tool",
          data: { name: "sessions_yield", message: "done" },
        }),
      ).toBe("internal_narration");
    });
  });

  describe("compaction", () => {
    it("always classifies as internal_narration", () => {
      expect(
        classifyCodexEvent({
          stream: "compaction",
          data: { phase: "end", backend: "codex-app-server" },
        }),
      ).toBe("internal_narration");
    });
  });

  describe("unknown streams (safe default)", () => {
    it("returns internal_narration for unknown streams", () => {
      expect(classifyCodexEvent({ stream: "some_future_codex_stream", data: { foo: "bar" } })).toBe(
        "internal_narration",
      );
    });

    it("fails closed on exceptions thrown by classifier", () => {
      // Simulate a pathological `data` that throws on any property access.
      // The classifier's try/catch must swallow the error and return the safe
      // default.
      const throwingData = new Proxy(
        {},
        {
          get() {
            throw new Error("boom");
          },
          has() {
            throw new Error("boom");
          },
          ownKeys() {
            throw new Error("boom");
          },
          getOwnPropertyDescriptor() {
            throw new Error("boom");
          },
        },
      );
      expect(
        classifyCodexEvent({
          stream: "codex_app_server.item",
          data: throwingData,
        }),
      ).toBe("internal_narration");
    });
  });

  describe("isCodexStream", () => {
    it("returns true for known codex streams", () => {
      expect(isCodexStream("codex_app_server.item")).toBe(true);
      expect(isCodexStream("codex_app_server.guardian")).toBe(true);
      expect(isCodexStream("codex_app_server.tool")).toBe(true);
      expect(isCodexStream("compaction")).toBe(true);
    });

    it("returns false for non-codex streams", () => {
      expect(isCodexStream("assistant")).toBe(false);
      expect(isCodexStream("lifecycle")).toBe(false);
      expect(isCodexStream("")).toBe(false);
    });
  });

  describe("CODEX_STREAM_CLASSIFIERS registry", () => {
    it("covers every exported classifier key", () => {
      const keys = Object.keys(CODEX_STREAM_CLASSIFIERS);
      expect(keys).toContain("codex_app_server.item");
      expect(keys).toContain("codex_app_server.guardian");
      expect(keys).toContain("codex_app_server.tool");
      expect(keys).toContain("compaction");
    });
  });
});

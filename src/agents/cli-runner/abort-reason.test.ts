import { describe, expect, it } from "vitest";
import { __testing as claudeLiveTesting } from "./claude-live-session.js";
import { __testing as executeTesting } from "./execute.js";

describe("CLI run abort error captures abort reason", () => {
  describe("claude-live-session.createAbortError", () => {
    const { createAbortError, describeAbortReason } = claudeLiveTesting;

    it("returns plain message when no reason is provided", () => {
      const err = createAbortError();
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("CLI run aborted");
    });

    it("includes a string reason verbatim", () => {
      const err = createAbortError("replyBackend:user_abort");
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("CLI run aborted: replyBackend:user_abort");
    });

    it("includes Error reason name and message", () => {
      const reason = new Error("Reply operation aborted for restart");
      reason.name = "AbortError";
      const err = createAbortError(reason);
      expect(err.message).toBe("CLI run aborted: AbortError: Reply operation aborted for restart");
    });

    it("ignores empty/whitespace reasons", () => {
      expect(createAbortError("").message).toBe("CLI run aborted");
      expect(createAbortError("   ").message).toBe("CLI run aborted");
      expect(createAbortError(null).message).toBe("CLI run aborted");
    });

    it("describeAbortReason serializes plain objects", () => {
      expect(describeAbortReason({ kind: "compact_restart" })).toBe('{"kind":"compact_restart"}');
      expect(describeAbortReason({})).toBeUndefined();
    });
  });

  describe("execute.createCliAbortError", () => {
    const { createCliAbortError } = executeTesting;

    it("attaches the chat-abort signal reason to the message", () => {
      const err = createCliAbortError("chat-abort:rpc");
      expect(err.name).toBe("AbortError");
      expect(err.message).toBe("CLI run aborted: chat-abort:rpc");
    });

    it("falls back to the legacy message when reason is missing", () => {
      const err = createCliAbortError();
      expect(err.message).toBe("CLI run aborted");
    });
  });
});

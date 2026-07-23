import { describe, expect, it, vi } from "vitest";
import { createEchoTracker } from "./echo.js";

describe("createEchoTracker", () => {
  it("keeps verbose previews UTF-16 safe without changing the tracked text", () => {
    const logVerbose = vi.fn();
    const tracker = createEchoTracker({ logVerbose });
    const prefix = "x".repeat(49);
    const text = `${prefix}😀tail`;

    tracker.rememberText(text, { logVerboseMessage: true });

    expect(logVerbose).toHaveBeenCalledExactlyOnceWith(
      `Added to echo detection set (size now: 1): ${prefix}...`,
    );
    expect(tracker.has(text)).toBe(true);
  });

  it("scopes echo detection by conversation so same text in different chats does not collide", () => {
    const tracker = createEchoTracker({});

    // Bot replies "Done." to Alice's chat (jid: chat-A).
    tracker.rememberText("Done.", { conversationId: "chat-A" });

    // True same-chat echo detection still works.
    expect(tracker.has("Done.", "chat-A")).toBe(true);

    // Bob in a different chat (jid: chat-B) sends "Done." — must not match.
    expect(tracker.has("Done.", "chat-B")).toBe(false);

    // After forgetting for chat-A, the text is no longer tracked.
    tracker.forget("Done.", "chat-A");
    expect(tracker.has("Done.", "chat-A")).toBe(false);
  });

  it("treats absent conversationId as unscoped for backward compatibility", () => {
    const tracker = createEchoTracker({});

    // Remember without conversation scope.
    tracker.rememberText("Hello", {});
    // Check without conversation scope — matches.
    expect(tracker.has("Hello")).toBe(true);
    // Check with conversation scope — unscoped text should not match scoped check.
    expect(tracker.has("Hello", "chat-X")).toBe(false);
    // A scoped remember also does not pollute the unscoped space.
    tracker.rememberText("World", { conversationId: "chat-A" });
    expect(tracker.has("World")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { shouldSupersedeTelegramReplyFence } from "./telegram-reply-fence.js";

describe("shouldSupersedeTelegramReplyFence", () => {
  it("keeps non-interrupting side and status commands from superseding active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/btw what changed?",
        CommandAuthorized: true,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/status",
        CommandAuthorized: true,
      }),
    ).toBe(false);
  });

  it("keeps normal turns and authorized aborts interrupting active runs", () => {
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "@bot answer this",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: true,
      }),
    ).toBe(true);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/stop",
        CommandAuthorized: false,
      }),
    ).toBe(false);
    expect(
      shouldSupersedeTelegramReplyFence({
        CommandBody: "/export-trajectory bundle",
        CommandAuthorized: true,
      }),
    ).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";

// mock-isolation: history projection must not initialize provider runtime bindings.
vi.mock("../../../plugins/provider-hook-runtime.js", () => {
  throw new Error("Sender history projection imported provider runtime");
});

describe("sender history projection import boundary", () => {
  it("projects sender context without initializing the provider runtime", async () => {
    const { projectPersistedSenderContext } = await import("./attempt-history.js");
    const message: PersistedUserTurnMessage = {
      role: "user",
      content: "Group statement",
      timestamp: 1,
      __openclaw: { senderName: "Alice" },
    };
    const [projected] = projectPersistedSenderContext([message]);
    expect(projected).toMatchObject({
      role: "user",
      content: expect.stringContaining('"name":"Alice"'),
    });
  });
});

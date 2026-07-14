import { describe, expect, it } from "vitest";
import { validateTerminalOpenParams } from "../index.js";

describe("terminal protocol", () => {
  it("accepts a typed catalog reference and rejects client command fields", () => {
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "thread" },
      }),
    ).toBe(true);
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        catalog: {
          catalogId: "codex",
          hostId: "gateway:local",
          threadId: "thread",
          argv: ["sh"],
        },
      }),
    ).toBe(false);
    expect(
      validateTerminalOpenParams({
        cols: 80,
        rows: 24,
        cwd: "/tmp",
      }),
    ).toBe(false);
  });
});

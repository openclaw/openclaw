import { describe, expect, it } from "vitest";
import { __testing } from "./agent-command.js";

describe("agent command ACP text accumulator", () => {
  it("flushes a buffered silent-prefix fragment from finalizeRaw", () => {
    const accumulator = __testing.createAcpVisibleTextAccumulator();

    expect(accumulator.consume("NO")).toBeNull();
    expect(accumulator.finalizeRaw()).toBe("NO");
    expect(accumulator.finalize()).toBe("NO");
  });
});

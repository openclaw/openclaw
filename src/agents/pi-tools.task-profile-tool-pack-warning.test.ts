import { beforeEach, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";

const logWarn = vi.fn();

vi.mock("../logger.js", () => ({
  logWarn,
}));

const { createOpenClawCodingTools } = await import("./pi-tools.js");

describe("createOpenClawCodingTools task-profile tool pack warnings", () => {
  beforeEach(() => {
    logWarn.mockReset();
  });

  it("does not warn about unavailable generated coding-pack tools in the current runtime", () => {
    createOpenClawCodingTools({
      senderIsOwner: true,
      modelProvider: "omlx",
      modelId: "Qwen3.5-122B-A10B-4bit",
      taskPrompt: "Fix the TypeScript build error in src/version.ts",
    });

    const warningLines = logWarn.mock.calls
      .map((call) => String(call[0] ?? ""))
      .filter((line) => line.includes("task-profile-tool-pack"));

    expect(warningLines).toEqual([]);
  });
});

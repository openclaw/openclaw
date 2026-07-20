import { describe, expect, it } from "vitest";
import {
  LOCAL_CODER_AGENT_ID,
  LOCAL_CODER_COMPLETION_CONTRACT,
  LOCAL_CODER_SCRATCH_DIRNAME,
  validateLocalCoderArtifactPath,
} from "./local-coder-artifacts.js";

describe("local-coder completion contract", () => {
  it("blocks a no-output terminal completion", () => {
    expect(LOCAL_CODER_COMPLETION_CONTRACT).toContain("no verified output");
    expect(LOCAL_CODER_COMPLETION_CONTRACT).toContain("blocked terminal");
  });

  it("enforces ownership and scratch path validation", () => {
    expect(LOCAL_CODER_AGENT_ID).toBe("local-coder");
    expect(LOCAL_CODER_SCRATCH_DIRNAME).toBe("scratch");
    expect(LOCAL_CODER_COMPLETION_CONTRACT).toContain("owns writes");
    expect(() =>
      validateLocalCoderArtifactPath("/tmp/result.txt", { hostScratchRoot: "/tmp/scratch" }),
    ).toThrow();
  });

  it("forbids parent-side persistence", () => {
    expect(LOCAL_CODER_COMPLETION_CONTRACT).toContain(
      "parent must not persist or copy the child's artifact",
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  resolveCodeModeMatrixOutputDir,
} from "../../../scripts/code-mode-model-matrix.ts";

describe("Code Mode matrix option boundaries", () => {
  it("rejects inherited object keys as option names", () => {
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/fixture", "constructor", "1"]),
    ).toThrow("Unknown argument: constructor");
  });

  it("confines output to a child of the repository", () => {
    const now = new Date("2026-07-28T12:00:00Z");
    expect(() => resolveCodeModeMatrixOutputDir("/repo", "../outside", now)).toThrow(
      "within the repository",
    );
    expect(() => resolveCodeModeMatrixOutputDir("/repo", "/tmp/out", now)).toThrow("repo-relative");
    expect(() => resolveCodeModeMatrixOutputDir("/repo", ".", now)).toThrow(
      "within the repository",
    );
  });
});

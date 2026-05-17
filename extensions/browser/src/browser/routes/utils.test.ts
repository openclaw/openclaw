import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeResponseFilePath } from "./utils.js";

describe("normalizeResponseFilePath", () => {
  it("preserves absolute POSIX paths", () => {
    expect(normalizeResponseFilePath("/tmp/fake.png")).toBe("/tmp/fake.png");
  });

  it("preserves absolute Windows paths", () => {
    expect(normalizeResponseFilePath("C:\\tmp\\fake.png")).toBe("C:\\tmp\\fake.png");
  });

  it("resolves relative paths to absolute host paths", () => {
    expect(normalizeResponseFilePath("relative/output.png")).toBe(
      path.resolve("relative/output.png"),
    );
  });
});

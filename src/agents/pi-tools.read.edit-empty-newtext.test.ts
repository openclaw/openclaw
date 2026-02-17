import { describe, it, expect } from "vitest";
import { assertRequiredParams, CLAUDE_PARAM_GROUPS } from "./pi-tools.read.js";

describe("edit tool: empty newText", () => {
  it("should accept empty string newText (deletion use case)", () => {
    expect(() =>
      assertRequiredParams(
        { path: "file.ts", oldText: "line to delete\n", newText: "" },
        CLAUDE_PARAM_GROUPS.edit,
        "Edit",
      ),
    ).not.toThrow();
  });

  it("should accept whitespace-only newText", () => {
    expect(() =>
      assertRequiredParams(
        { path: "file.ts", oldText: "old\n", newText: "\n" },
        CLAUDE_PARAM_GROUPS.edit,
        "Edit",
      ),
    ).not.toThrow();
  });

  it("should still reject missing newText entirely", () => {
    expect(() =>
      assertRequiredParams({ path: "file.ts", oldText: "old\n" }, CLAUDE_PARAM_GROUPS.edit, "Edit"),
    ).toThrow(/newText/);
  });

  it("should still reject missing oldText", () => {
    expect(() =>
      assertRequiredParams({ path: "file.ts", newText: "new" }, CLAUDE_PARAM_GROUPS.edit, "Edit"),
    ).toThrow(/oldText/);
  });
});

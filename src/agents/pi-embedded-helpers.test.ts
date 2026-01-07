import { describe, expect, it } from "vitest";

import { buildBootstrapContextFiles } from "./pi-embedded-helpers.js";
import {
  DEFAULT_AGENTS_FILENAME,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

const makeFile = (
  overrides: Partial<WorkspaceBootstrapFile>,
): WorkspaceBootstrapFile => ({
  name: DEFAULT_AGENTS_FILENAME,
  path: "/tmp/AGENTS.md",
  content: "",
  missing: false,
  ...overrides,
});

describe("buildBootstrapContextFiles", () => {
  it("keeps missing markers", () => {
    const files = [makeFile({ missing: true, content: undefined })];
    expect(buildBootstrapContextFiles(files)).toEqual([
      {
        path: DEFAULT_AGENTS_FILENAME,
        content: "[MISSING] Expected at: /tmp/AGENTS.md",
      },
    ]);
  });

  it("skips empty or whitespace-only content", () => {
    const files = [makeFile({ content: "   \n  " })];
    expect(buildBootstrapContextFiles(files)).toEqual([]);
  });

  it("truncates large bootstrap content", () => {
    const head = `HEAD-${"a".repeat(6000)}`;
    const tail = `${"b".repeat(3000)}-TAIL`;
    const long = `${head}${tail}`;
    const files = [makeFile({ content: long })];
    const [result] = buildBootstrapContextFiles(files);
    expect(result?.content).toContain(
      "[...truncated, read AGENTS.md for full content...]",
    );
    expect(result?.content.length).toBeLessThan(long.length);
    expect(result?.content.startsWith(long.slice(0, 120))).toBe(true);
    expect(result?.content.endsWith(long.slice(-120))).toBe(true);
  });
});

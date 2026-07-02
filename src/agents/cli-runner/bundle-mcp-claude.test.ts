// Tests for Claude bundle-MCP arg helpers, focused on variadic --mcp-config.
import { describe, expect, it } from "vitest";
import { findClaudeMcpConfigPaths, injectClaudeMcpConfigArgs } from "./bundle-mcp-claude.js";

describe("findClaudeMcpConfigPaths", () => {
  it("returns empty array when args are absent", () => {
    expect(findClaudeMcpConfigPaths(undefined)).toEqual([]);
    expect(findClaudeMcpConfigPaths([])).toEqual([]);
  });

  it("collects a single --mcp-config value", () => {
    expect(findClaudeMcpConfigPaths(["--mcp-config", "a.json"])).toEqual(["a.json"]);
  });

  it("collects every variadic value following --mcp-config", () => {
    expect(findClaudeMcpConfigPaths(["--mcp-config", "a.json", "b.json"])).toEqual([
      "a.json",
      "b.json",
    ]);
  });

  it("stops variadic collection at the next dash-prefixed arg", () => {
    expect(
      findClaudeMcpConfigPaths(["--mcp-config", "a.json", "b.json", "--strict-mcp-config"]),
    ).toEqual(["a.json", "b.json"]);
  });

  it("collects --mcp-config=path form values", () => {
    expect(findClaudeMcpConfigPaths(["--mcp-config=a.json"])).toEqual(["a.json"]);
  });

  it("combines variadic and equals-form values across multiple occurrences", () => {
    expect(
      findClaudeMcpConfigPaths(["--mcp-config", "a.json", "b.json", "--mcp-config=c.json"]),
    ).toEqual(["a.json", "b.json", "c.json"]);
  });
});

describe("injectClaudeMcpConfigArgs", () => {
  it("appends strict + mcp-config when no user mcp-config is present", () => {
    expect(injectClaudeMcpConfigArgs(["./fake-claude.mjs"], "openclaw.json")).toEqual([
      "./fake-claude.mjs",
      "--strict-mcp-config",
      "--mcp-config",
      "openclaw.json",
    ]);
  });

  it("strips every variadic --mcp-config value so none leak as positional args", () => {
    // --mcp-config is variadic: every following non-dash value is a config path.
    // The variadic collection ends at the next dash-prefixed arg (or end of args),
    // matching stripClaudeSideQuestionConflictingArgs.
    const stripped = injectClaudeMcpConfigArgs(
      ["./fake-claude.mjs", "--mcp-config", "a.json", "b.json"],
      "openclaw.json",
    );
    expect(stripped).not.toContain("a.json");
    expect(stripped).not.toContain("b.json");
    expect(stripped).toEqual([
      "./fake-claude.mjs",
      "--strict-mcp-config",
      "--mcp-config",
      "openclaw.json",
    ]);
  });

  it("strips --mcp-config=value form along with variadic neighbors", () => {
    const stripped = injectClaudeMcpConfigArgs(
      ["./fake-claude.mjs", "--mcp-config=a.json", "--mcp-config", "b.json"],
      "openclaw.json",
    );
    expect(stripped).not.toContain("a.json");
    expect(stripped).not.toContain("b.json");
    expect(stripped).not.toContain("--mcp-config=a.json");
  });

  it("strips user-supplied --strict-mcp-config so OpenClaw's overlay is authoritative", () => {
    const stripped = injectClaudeMcpConfigArgs(
      ["--strict-mcp-config", "./fake-claude.mjs"],
      "openclaw.json",
    );
    expect(stripped.filter((arg) => arg === "--strict-mcp-config")).toHaveLength(1);
  });
});

import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { defaultRuntime, theme } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { afterEach, expect, it, vi } from "vitest";
import { renderMemorySearch } from "./cli-search-output.js";

const hit: MemorySearchResult = {
  path: "memory/re\u001b[2Jport\u0007\u009b2K\t\r\n.md",
  startLine: 1,
  endLine: 4,
  score: 0.91,
  snippet:
    "saffronleaf first line\nsecond \u001b[2Jline\u0007 \u009b2Kend\tcolumn\rreturn\nfinal line.",
  source: "memory",
};

afterEach(() => {
  vi.restoreAllMocks();
});

it("renders safe file-derived text while preserving snippet line breaks", () => {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

  renderMemorySearch({ results: [{ ...hit }] });

  expect(log).toHaveBeenCalledWith(
    [
      `${theme.success("0.910")} ${theme.accent("memory/report\\t\\r\\n.md:1-4")}`,
      theme.muted("saffronleaf first line\nsecond line end\\tcolumn\\rreturn\nfinal line."),
    ].join("\n"),
  );
});

it("preserves raw file-derived text in JSON results", () => {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});

  renderMemorySearch({ results: [{ ...hit }] }, true);

  expect(writeJson).toHaveBeenCalledWith({ results: [hit] });
  expect(log).not.toHaveBeenCalled();
});

/**
 * Tests required parameter validation for model-supplied tools.
 * Covers retry guidance, XML suffix cleanup, and hallucinated document
 * extension handling (read correction, write/edit rejection) for file
 * operations.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredParams,
  correctHallucinatedFileExtension,
  correctHallucinatedFileExtensionFromKeys,
  getToolParamsRecord,
  hasHallucinatedFileExtension,
  rejectHallucinatedFileExtensionFromKeys,
  REQUIRED_PARAM_GROUPS,
  stripMalformedXmlArgValueSuffix,
  stripMalformedXmlArgValueSuffixFromKeys,
  wrapToolParamValidation,
} from "./agent-tools.params.js";

// ── XML suffix cleanup (unchanged) ──────────────────────────────

describe("stripMalformedXmlArgValueSuffix", () => {
  it("strips only the malformed terminal XML arg-value suffix", () => {
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>>")).toBe("echo test");
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>>>>>")).toBe("echo test");
    expect(stripMalformedXmlArgValueSuffix("echo test</arg_value>")).toBe("echo test</arg_value>");
    expect(stripMalformedXmlArgValueSuffix("echo </arg_value>> test")).toBe(
      "echo </arg_value>> test",
    );
  });
});

describe("stripMalformedXmlArgValueSuffixFromKeys", () => {
  it("strips malformed path suffixes without touching payload text", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await tool.execute("id", {
      path: "notes.txt</arg_value>>",
      content: "keep literal payload</arg_value>>",
    });

    expect(execute).toHaveBeenCalledWith(
      "id",
      {
        path: "notes.txt",
        content: "keep literal payload</arg_value>>",
      },
      undefined,
      undefined,
    );
  });

  it("does NOT correct hallucinated extensions (XML-only helper)", () => {
    const result = stripMalformedXmlArgValueSuffixFromKeys(
      { path: "report.docodex" },
      ["path"],
    );
    expect(result.path).toBe("report.docodex");
  });

  it("strips XML suffix but keeps hallucinated extension", () => {
    const result = stripMalformedXmlArgValueSuffixFromKeys(
      { path: "report.docodex</arg_value>>" },
      ["path"],
    );
    expect(result.path).toBe("report.docodex");
  });
});

// ── Hallucinated extension detection ────────────────────────────

describe("hasHallucinatedFileExtension", () => {
  it("detects known hallucinated extensions", () => {
    expect(hasHallucinatedFileExtension("report.docodex")).toBe(true);
    expect(hasHallucinatedFileExtension("slides.pptcodex")).toBe(true);
    expect(hasHallucinatedFileExtension("budget.xlscodex")).toBe(true);
    expect(hasHallucinatedFileExtension("report.docxcodex")).toBe(true);
    expect(hasHallucinatedFileExtension("slides.pptxcodex")).toBe(true);
    expect(hasHallucinatedFileExtension("budget.xlstcodex")).toBe(true);
    expect(hasHallucinatedFileExtension("budget.xltxcodex")).toBe(true);
    expect(hasHallucinatedFileExtension("budget.xlstxcodex")).toBe(true);
  });

  it("returns false for real extensions", () => {
    expect(hasHallucinatedFileExtension("report.docx")).toBe(false);
    expect(hasHallucinatedFileExtension("slides.pptx")).toBe(false);
    expect(hasHallucinatedFileExtension("budget.xlsx")).toBe(false);
    expect(hasHallucinatedFileExtension("notes.txt")).toBe(false);
    expect(hasHallucinatedFileExtension("README.md")).toBe(false);
  });

  it("returns false for paths without extensions", () => {
    expect(hasHallucinatedFileExtension("noext")).toBe(false);
  });
});

// ── Hallucinated extension correction (read-only) ──────────────

describe("correctHallucinatedFileExtension", () => {
  it("corrects known hallucinated extensions", () => {
    expect(correctHallucinatedFileExtension("report.docodex")).toBe("report.docx");
    expect(correctHallucinatedFileExtension("slides.pptcodex")).toBe("slides.pptx");
    expect(correctHallucinatedFileExtension("budget.xlscodex")).toBe("budget.xlsx");
    expect(correctHallucinatedFileExtension("report.docxcodex")).toBe("report.docx");
  });

  it("preserves real extensions", () => {
    expect(correctHallucinatedFileExtension("report.docx")).toBe("report.docx");
    expect(correctHallucinatedFileExtension("notes.txt")).toBe("notes.txt");
  });

  it("preserves paths without extensions", () => {
    expect(correctHallucinatedFileExtension("noext")).toBe("noext");
  });

  it("corrects paths with directory prefixes", () => {
    expect(correctHallucinatedFileExtension("path/to/report.docodex")).toBe("path/to/report.docx");
    expect(correctHallucinatedFileExtension("/abs/path/slides.pptcodex")).toBe(
      "/abs/path/slides.pptx",
    );
  });
});

describe("correctHallucinatedFileExtensionFromKeys", () => {
  it("corrects hallucinated extensions on path keys", () => {
    const result = correctHallucinatedFileExtensionFromKeys(
      { path: "report.docodex" },
      ["path"],
    );
    expect(result.path).toBe("report.docx");
  });

  it("does not mutate when no correction is needed", () => {
    const input = { path: "report.docx" };
    const result = correctHallucinatedFileExtensionFromKeys(input, ["path"]);
    expect(result).toBe(input); // same reference, no copy
  });

  it("does not touch non-path keys", () => {
    const result = correctHallucinatedFileExtensionFromKeys(
      { path: "report.docodex", content: "hello.docodex" },
      ["path"],
    );
    expect(result.path).toBe("report.docx");
    expect(result.content).toBe("hello.docodex");
  });
});

// ── Hallucinated extension rejection (write/edit) ──────────────

describe("rejectHallucinatedFileExtensionFromKeys", () => {
  it("rejects hallucinated extensions on write paths", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { path: "report.docodex" },
        ["path"],
        "write",
      ),
    ).toThrow(/hallucinated file extension/);
  });

  it("rejects with retry guidance suffix", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { path: "budget.xlscodex" },
        ["path"],
        "edit",
      ),
    ).toThrow(/Supply correct parameters before retrying/);
  });

  it("suggests the correct extension in the error message", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { path: "report.docodex" },
        ["path"],
        "write",
      ),
    ).toThrow(/\.docx/);
  });

  it("does not reject real extensions", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { path: "report.docx" },
        ["path"],
        "write",
      ),
    ).not.toThrow();
  });

  it("does not reject non-path keys", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { content: "content with .docodex" },
        ["path"],
        "write",
      ),
    ).not.toThrow();
  });

  it("rejects after XML suffix stripping", () => {
    expect(() =>
      rejectHallucinatedFileExtensionFromKeys(
        { path: "report.docodex</arg_value>>" },
        ["path"],
        "write",
      ),
    ).toThrow(/hallucinated file extension/);
  });
});

// ── wrapToolParamValidation integration ─────────────────────────

describe("assertRequiredParams", () => {
  it("returns object params unchanged", () => {
    const params = { path: "test.txt" };
    expect(getToolParamsRecord(params)).toBe(params);
  });

  it("rejects paths that become empty after malformed XML arg-value suffix stripping", async () => {
    const execute = vi.fn();
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await expect(tool.execute("id", { path: "</arg_value>>", content: "x" })).rejects.toThrow(
      /Missing required parameter: path/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves edit replacement payloads while cleaning the path", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "edit",
        label: "edit",
        description: "edit a file",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.edit,
    );

    const edits = [
      {
        oldText: "literal old</arg_value>>",
        newText: "literal new</arg_value>>",
      },
    ];
    await tool.execute("id", { path: "notes.txt</arg_value>>>", edits });

    expect(execute).toHaveBeenCalledWith("id", { path: "notes.txt", edits }, undefined, undefined);
  });

  it("includes received keys in error when some params are present but content is missing", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)/);
  });

  it("does not normalize legacy aliases during validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute("id", { file_path: "test.txt" }, new AbortController().signal, vi.fn()),
    ).rejects.toThrow(/\(received: file_path\)/);
  });

  it("enforces canonical path/content at runtime", async () => {
    const execute = vi.fn(async (_id, args) => args);
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "test",
        parameters: {},
        execute,
      },
      REQUIRED_PARAM_GROUPS.write,
    );

    await tool.execute("tool-1", { path: "foo.txt", content: "x" });
    expect(execute).toHaveBeenCalledWith(
      "tool-1",
      { path: "foo.txt", content: "x" },
      undefined,
      undefined,
    );

    await expect(tool.execute("tool-2", { content: "x" })).rejects.toThrow(
      /Missing required parameter/,
    );
    await expect(tool.execute("tool-2", { content: "x" })).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
    await expect(tool.execute("tool-3", { path: "   ", content: "x" })).rejects.toThrow(
      /Missing required parameter/,
    );
    await expect(tool.execute("tool-3", { path: "   ", content: "x" })).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
    await expect(tool.execute("tool-4", {})).rejects.toThrow(
      /Missing required parameters: path, content/,
    );
    await expect(tool.execute("tool-4", {})).rejects.toThrow(
      /Supply correct parameters before retrying\./,
    );
  });

  it("excludes null and undefined values from received hint", () => {
    expect(() =>
      assertRequiredParams(
        { path: "test.txt", content: null },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path\)[^,]/);
  });

  it("shows empty-string values for present params that still fail validation", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", content: "   " },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, content=<empty-string>\)/);
  });

  it("shows wrong-type values for present params that still fail validation", async () => {
    const tool = wrapToolParamValidation(
      {
        name: "write",
        label: "write",
        description: "write a file",
        parameters: {},
        execute: vi.fn(),
      },
      REQUIRED_PARAM_GROUPS.write,
    );
    await expect(
      tool.execute(
        "id",
        { path: "test.txt", content: { unexpected: true } },
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow(/\(received: (?:path, content=<object>|content=<object>, path)\)/);
  });

  it("includes multiple received keys when several params are present", () => {
    expect(() =>
      assertRequiredParams(
        { path: "/tmp/a.txt", extra: "yes" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toThrow(/\(received: path, extra\)/);
  });

  it("omits received hint when the record is empty", () => {
    const err = (() => {
      try {
        assertRequiredParams({}, [{ keys: ["content"], label: "content" }], "write");
      } catch (e) {
        return e instanceof Error ? e.message : "";
      }
      return "";
    })();
    expect(err).not.toMatch(/received:/);
    expect(err).toMatch(/Missing required parameter: content/);
  });

  it("returns undefined when all required params are present", () => {
    expect(
      assertRequiredParams(
        { path: "a.txt", content: "hello" },
        [
          { keys: ["path"], label: "path" },
          { keys: ["content"], label: "content" },
        ],
        "write",
      ),
    ).toBeUndefined();
  });
});

// ── wrapToolParamValidation: hallucinated extension integration ──

describe("wrapToolParamValidation: hallucinated extensions", () => {
  describe("read tools (silent correction)", () => {
    it("silently corrects hallucinated extensions on read paths", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool = wrapToolParamValidation(
        {
          name: "read",
          label: "read",
          description: "read a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.read,
      );

      await tool.execute("id", { path: "report.docodex" });

      expect(execute).toHaveBeenCalledWith(
        "id",
        { path: "report.docx" },
        undefined,
        undefined,
      );
    });

    it("corrects hallucinated extensions after XML suffix stripping", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool = wrapToolParamValidation(
        {
          name: "read",
          label: "read",
          description: "read a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.read,
      );

      await tool.execute("id", { path: "report.docodex</arg_value>>" });

      expect(execute).toHaveBeenCalledWith(
        "id",
        { path: "report.docx" },
        undefined,
        undefined,
      );
    });

    it("does not modify real extensions on read paths", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool = wrapToolParamValidation(
        {
          name: "read",
          label: "read",
          description: "read a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.read,
      );

      await tool.execute("id", { path: "report.docx" });

      expect(execute).toHaveBeenCalledWith(
        "id",
        { path: "report.docx" },
        undefined,
        undefined,
      );
    });
  });

  describe("write/edit tools (rejection)", () => {
    it("rejects hallucinated extensions on write paths", async () => {
      const execute = vi.fn();
      const tool = wrapToolParamValidation(
        {
          name: "write",
          label: "write",
          description: "write a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.write,
      );

      await expect(
        tool.execute("id", { path: "report.docodex", content: "x" }),
      ).rejects.toThrow(/hallucinated file extension/);

      expect(execute).not.toHaveBeenCalled();
    });

    it("rejects hallucinated extensions on edit paths", async () => {
      const execute = vi.fn();
      const tool = wrapToolParamValidation(
        {
          name: "edit",
          label: "edit",
          description: "edit a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.edit,
      );

      const edits = [{ oldText: "a", newText: "b" }];
      await expect(
        tool.execute("id", { path: "budget.xlscodex", edits }),
      ).rejects.toThrow(/hallucinated file extension/);

      expect(execute).not.toHaveBeenCalled();
    });

    it("accepts real extensions on write paths", async () => {
      const execute = vi.fn(async (_id, args) => args);
      const tool = wrapToolParamValidation(
        {
          name: "write",
          label: "write",
          description: "write a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.write,
      );

      await tool.execute("id", { path: "report.docx", content: "x" });

      expect(execute).toHaveBeenCalledWith(
        "id",
        { path: "report.docx", content: "x" },
        undefined,
        undefined,
      );
    });

    it("rejects hallucinated extensions after XML suffix stripping on write paths", async () => {
      const execute = vi.fn();
      const tool = wrapToolParamValidation(
        {
          name: "write",
          label: "write",
          description: "write a file",
          parameters: {},
          execute,
        },
        REQUIRED_PARAM_GROUPS.write,
      );

      await expect(
        tool.execute("id", { path: "report.docodex</arg_value>>", content: "x" }),
      ).rejects.toThrow(/hallucinated file extension/);
    });
  });
});

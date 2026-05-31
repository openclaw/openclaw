import { describe, expect, it, vi } from "vitest";
import {
  assertRequiredParams,
  REQUIRED_PARAM_GROUPS,
  getToolParamsRecord,
  stripXmlArgValueSuffix,
  stripXmlArgValueSuffixFromParams,
  stripXmlArgValueSuffixFromToolParams,
  XML_ARG_VALUE_SUFFIX_PARAM_KEYS,
  wrapToolParamValidation,
} from "./agent-tools.params.js";

describe("assertRequiredParams", () => {
  it("returns object params unchanged", () => {
    const params = { path: "test.txt" };
    expect(getToolParamsRecord(params)).toBe(params);
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

describe("stripXmlArgValueSuffix", () => {
  it("strips leaked arg_value suffixes from command and path values", () => {
    expect(stripXmlArgValueSuffix('echo "test</arg_value>>')).toBe('echo "test');
    expect(stripXmlArgValueSuffix("src/index.ts</arg_value>>>>>")).toBe("src/index.ts");
  });

  it("leaves embedded XML-like text unchanged", () => {
    expect(stripXmlArgValueSuffix("before </arg_value>> after")).toBe("before </arg_value>> after");
    expect(stripXmlArgValueSuffix("before </arg_value>")).toBe("before </arg_value>");
  });

  it("normalizes only selected fields", () => {
    const params = {
      path: "src/index.ts</arg_value>>",
      content: "keep this literal </arg_value>>",
    };

    expect(stripXmlArgValueSuffixFromParams(params, XML_ARG_VALUE_SUFFIX_PARAM_KEYS.path)).toEqual({
      path: "src/index.ts",
      content: "keep this literal </arg_value>>",
    });
    expect(params.path).toBe("src/index.ts</arg_value>>");
  });

  it("normalizes only tool-owned argument fields", () => {
    const params = {
      path: "notes.txt</arg_value>>",
      content: "literal content </arg_value>>",
    };

    expect(stripXmlArgValueSuffixFromToolParams("write", params)).toEqual({
      path: "notes.txt",
      content: "literal content </arg_value>>",
    });
    expect(stripXmlArgValueSuffixFromToolParams("message", params)).toBe(params);
    expect(
      stripXmlArgValueSuffixFromToolParams("exec", {
        code: "return 1;</arg_value>>",
        command: "echo ok</arg_value>>",
        content: "literal content </arg_value>>",
      }),
    ).toEqual({
      code: "return 1;",
      command: "echo ok",
      content: "literal content </arg_value>>",
    });
  });
});

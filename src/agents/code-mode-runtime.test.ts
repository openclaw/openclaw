import { describe, expect, it } from "vitest";
import {
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
} from "./code-mode-json.js";
import { isCodeModeEngagedForModel, resolveCodeModeConfig } from "./code-mode-runtime.js";
import { parseCodeModeScriptSyntax } from "./code-mode-script-syntax.js";
import { prepareSource } from "./code-mode-source.js";

function projectResult(params: {
  output: unknown[];
  value?: unknown;
  error?: string;
  maxOutputBytes: number;
}) {
  const state = new CodeModeOutputState(params.maxOutputBytes);
  state.append(captureCodeModeOutput(params.output, params.maxOutputBytes));
  return state.take({
    ...(Object.hasOwn(params, "value")
      ? { value: captureCodeModeValue(params.value, params.maxOutputBytes) }
      : {}),
    ...(params.error === undefined ? {} : { error: params.error }),
  });
}

const serializedBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

describe("Code Mode output bounding", () => {
  it("preserves Unicode output at its exact serialized byte limit", () => {
    const output = [{ type: "text", text: "😀 café".repeat(200) }];
    const maxOutputBytes = serializedBytes(output);

    expect(projectResult({ output, maxOutputBytes }).output).toEqual(output);
    expect(output).toEqual([{ type: "text", text: "😀 café".repeat(200) }]);

    const bounded = projectResult({ output, maxOutputBytes: maxOutputBytes - 1 });
    expect(JSON.stringify(bounded.output)).toContain("rerun with narrower args");
  });

  it("bounds output and the returned value under one serialized budget", () => {
    const output = [{ type: "text", text: "😀".repeat(200) }];
    const value = { result: "café".repeat(200) };
    const maxOutputBytes = serializedBytes(output) + serializedBytes(value);

    expect(projectResult({ output, value, maxOutputBytes })).toMatchObject({ output, value });

    const bounded = projectResult({ output, value, maxOutputBytes: maxOutputBytes - 1 });
    expect(serializedBytes(bounded.output) + serializedBytes(bounded.value)).toBeLessThanOrEqual(
      maxOutputBytes - 1,
    );
  });

  it("does not charge an empty output array against the returned value", () => {
    const value = "ok";
    const maxOutputBytes = serializedBytes(value);

    expect(projectResult({ output: [], value, maxOutputBytes })).toMatchObject({
      output: [],
      value,
    });
  });

  it("preserves failure text and output at their exact serialized byte limit", () => {
    const output = [{ type: "text", text: "before failure" }];
    const error = "Error: café 😀";
    const maxOutputBytes = serializedBytes(output) + serializedBytes(error);
    expect(projectResult({ output, error, maxOutputBytes })).toEqual({ output, error });
  });

  const oversizedOutput = [{ type: "text", text: "output ".repeat(1_000) }];
  it.each([
    ["😀 café ", [], {}],
    ['\\"\n\t', [], {}],
    ["😀 failure ", oversizedOutput, {}],
    ["😀 failure ", oversizedOutput, { value: "value ".repeat(1_000) }],
  ] satisfies Array<[string, unknown[], { value?: string }]>)(
    "bounds %j with output %j and return %j without losing the cause or splitting Unicode",
    (errorText, output, returned) => {
      const maxOutputBytes = 1_024;
      const bounded = projectResult({
        output,
        error: `Error: ${errorText.repeat(1_000)}`,
        ...returned,
        maxOutputBytes,
      });

      expect(bounded.error).toMatch(/^Error: .*\[error truncated\]$/s);
      expect(bounded.error).not.toContain("�");
      const totalBytes =
        serializedBytes(bounded.error) +
        (bounded.output.length ? serializedBytes(bounded.output) : 0) +
        (Object.hasOwn(returned, "value") ? serializedBytes(bounded.value) : 0);
      expect(totalBytes).toBeLessThanOrEqual(maxOutputBytes);
    },
  );
});

describe("Code Mode source retention", () => {
  it.each([65536])("retains at most %i source bytes per channel across repeated legs", (cap) => {
    const original = [{ type: "text", text: "🦞".repeat(Math.ceil(cap / 4)) }];
    const state = new CodeModeOutputState(cap);
    const leg = captureCodeModeOutput(original, cap);
    const value = captureCodeModeValue(original[0], cap);
    expect(Buffer.byteLength(leg.source.json)).toBeLessThanOrEqual(cap);
    expect(Buffer.byteLength(value.json)).toBeLessThanOrEqual(cap);
    for (let index = 1; index <= 8; index++) {
      state.append(leg);
      state.append(captureCodeModeOutput([], cap));
      expect(state.source.count).toBe(index);
      expect(Buffer.byteLength(state.source.source.json)).toBeLessThanOrEqual(cap);
      expect(state.source.source).toMatchObject({
        kind: "prefix",
        originalBytes: index * (Buffer.byteLength(JSON.stringify(original)) - 1) + 1,
      });
    }
    expect(state.source.source.json).toBe(leg.source.json);
  });
});

describe("Code Mode master switch resolution", () => {
  it.each([
    { name: "boolean shorthand true", codeMode: true, enabled: true },
    { name: "boolean shorthand false", codeMode: false, enabled: false },
    { name: "auto shorthand", codeMode: "auto", enabled: "auto" },
    { name: "object enabled auto", codeMode: { enabled: "auto" }, enabled: "auto" },
    { name: "object with options", codeMode: { timeoutMs: 5000 }, enabled: false },
    { name: "omitted", codeMode: undefined, enabled: "auto" },
  ])("resolves enabled for $name", ({ codeMode, enabled }) => {
    expect(resolveCodeModeConfig({ tools: { codeMode } } as never).enabled).toBe(enabled);
  });

  const preferredModel = { compat: { codeMode: "preferred" } };
  const capableModel = { compat: { codeMode: "capable" } };
  const unflaggedModel = { compat: { supportsTools: true } };

  it.each([
    [true, unflaggedModel, true],
    [false, preferredModel, false],
    ["auto", preferredModel, true],
    ["auto", capableModel, false],
    ["auto", unflaggedModel, false],
    ["auto", undefined, false],
  ] as const)("engages %s for %j: %s", (enabled, model, engaged) => {
    expect(isCodeModeEngagedForModel({ enabled }, model)).toBe(engaged);
  });
});

describe("Code Mode guest source validation", () => {
  it.each([
    ["const answer = ;", "1:16"],
    [`const label = "${"😀".repeat(96)}";\nconst answer = ; return import('node:fs');`, "2:16"],
    ["import fs from 'node:fs';", "1:1"],
    ["return import.meta.url;", "1:8"],
  ])("rejects malformed JavaScript %j at %s", (code, location) => {
    expect(() => prepareSource(code)).toThrow(
      "SyntaxError at openclaw-code-mode:user.js:" + location,
    );
  });

  it("keeps an astral identifier whole at the syntax diagnostic cap", () => {
    const name = `${"a".repeat(227)}\u{1D400}`;
    const code = `const ${name} = 1; const ${name} = 2;`;
    let error: unknown;
    try {
      prepareSource(code);
    } catch (cause) {
      error = cause;
    }
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain(`Identifier '${"a".repeat(227)}`);
    expect(message.includes("\uD835")).toBe(false);
  });

  it("bounds diagnostics containing long duplicate identifiers", () => {
    const name = "a".repeat(10_000);
    const code = "let " + name + "; let " + name + ";";
    let error: unknown;
    try {
      prepareSource(code);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("SyntaxError at openclaw-code-mode:user.js:1:");
    expect(String(error).length).toBeLessThan(500);
  });

  it("reports syntax errors at user-relative locations", () => {
    expect(parseCodeModeScriptSyntax("const x = ;")).toEqual({
      ok: false,
      message: "Unexpected token",
      line: 1,
      column: 10,
    });
  });

  it.each([
    "return `\\${import('node:fs')}`;",
    "return `escaped \\` require('node:fs')`;",
    "return `outer ${{ value: `import('node:fs')` }.value}`;",
    "// require('node:fs')\nreturn 7;",
    "/* import('node:fs') */ return 7;",
    "return \"require('node:fs')\";",
    'return `${/import.meta/.test("import.meta")}`;',
    'return /[a/]import.meta/.test("aimport.meta");',
    "const value = { if() { return 10; } }; return value?.if() / /import.meta/.source.length;",
    "function run() { const await = 10; return await / /import.meta/.source.length; } return run();",
    "class Guest { #return = 10; run() { return this.#return / /import.meta/.source.length; } } return new Guest().run();",
    "const api = { import(value) { return value; } }; return api.import(42);",
    "const api = { require(value) { return value; } }; return api.require(42);",
    "const api = { import(value) { return value; } }; return api?.import?.(42);",
    'const api = { require(value) { return value; } }; return api["require"](42);',
    "const api = { import: { meta: 42 } }; return api.import.meta;",
  ])("preserves %s", (code) => {
    expect(prepareSource(code)).toBe(code);
  });

  it.each([
    "return require('node:fs');",
    "return import('node:fs');",
    "return require /* hidden */ ('node:fs');",
    String.raw`return r\u0065quire('node:fs');`,
    "return require?.('node:fs');",
    "return (require)('node:fs');",
    "return (0, require)('node:fs');",
    "return `${`nested ${import('node:fs')}`}`;",
    "return `${({ value: import('node:fs') }).value}`;",
    "const value = { if() { return 1; } }; return value?.if() / import('node:fs');",
    "class Guest { #return = 1; run() { return this.#return / (globalThis.pending = import('node:fs')); } } new Guest().run(); return globalThis.pending;",
    `const label = "${"😀".repeat(96)}"; return import('node:fs');`,
    `const label = "${"😀".repeat(96)}"; return require('node:fs');`,
  ])("rejects %s", (code) => {
    expect(() => prepareSource(code)).toThrow("code mode module access is disabled");
  });

  it.each([
    [
      "existing parser limitation: dynamic import after an optional keyword property",
      "const value = { return: 1 }; return value?.return / import('node:fs') / 1;",
      "SyntaxError at openclaw-code-mode:user.js:1:51: Unexpected token. No tools were dispatched; correct the JavaScript source and submit it again.",
    ],
    [
      "existing parser limitation: require after an optional keyword property",
      "const value = { return: 1 }; return value?.return / require('node:fs') / 1;",
      "SyntaxError at openclaw-code-mode:user.js:1:51: Unexpected token. No tools were dispatched; correct the JavaScript source and submit it again.",
    ],
  ])("rejects %s", (_name, code, expectedError) => {
    expect(() => prepareSource(code)).toThrow(expectedError);
  });

  it("names the replacement tool path in the module access rejection", () => {
    const rejectModuleAccess = () => prepareSource("return require('node:fs');");

    expect(rejectModuleAccess).toThrow("code mode module access is disabled.");
    expect(rejectModuleAccess).toThrow("Call an enabled async tool global from guest JavaScript");
    expect(rejectModuleAccess).toThrow("catalog.search(query) when the bounded quick index omits");
    expect(rejectModuleAccess).toThrow("Do not retry the same source with require() or an import.");
  });
});

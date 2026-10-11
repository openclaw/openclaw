import { describe, expect, it } from "vitest";
import {
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
} from "./code-mode-json.js";
import { isCodeModeEngagedForModel, resolveCodeModeConfig } from "./code-mode-runtime.js";
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

describe("Code Mode output bounding", () => {
  it.each([
    {
      name: "error, output, and value",
      errorText: "😀 failure ",
      output: [{ type: "text", text: "output ".repeat(1_000) }],
      returned: { value: "value ".repeat(1_000) },
    },
  ])(
    "bounds $name without losing the cause or splitting Unicode",
    ({ errorText, output, returned }) => {
      const maxOutputBytes = 1_024;
      const bounded = projectResult({
        output,
        error: `Error: ${errorText.repeat(1_000)}`,
        ...returned,
        maxOutputBytes,
      });

      expect(bounded.error).toMatch(/^Error: .*\[error truncated\]$/s);
      expect(bounded.error).not.toContain("�");
      const serializedBytes =
        Buffer.byteLength(JSON.stringify(bounded.error), "utf8") +
        (bounded.output.length ? Buffer.byteLength(JSON.stringify(bounded.output), "utf8") : 0) +
        (Object.hasOwn(returned, "value")
          ? Buffer.byteLength(JSON.stringify(bounded.value), "utf8")
          : 0);
      expect(serializedBytes).toBeLessThanOrEqual(maxOutputBytes);
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
    { name: "object with options", codeMode: { timeoutMs: 5000 }, enabled: false },
    { name: "omitted", codeMode: undefined, enabled: "auto" },
  ])("resolves enabled for $name", ({ codeMode, enabled }) => {
    expect(resolveCodeModeConfig({ tools: { codeMode } } as never).enabled).toBe(enabled);
  });

  const preferredModel = { compat: { codeMode: "preferred" } };
  const unflaggedModel = { compat: { supportsTools: true } };

  it.each([
    {
      name: "true engages an unflagged model",
      enabled: true,
      model: unflaggedModel,
      engaged: true,
    },
    {
      name: "auto engages a preferred model",
      enabled: "auto",
      model: preferredModel,
      engaged: true,
    },
    { name: "auto skips a missing model", enabled: "auto", model: undefined, engaged: false },
  ] as const)("$name", ({ enabled, model, engaged }) => {
    expect(isCodeModeEngagedForModel({ enabled }, model)).toBe(engaged);
  });
});

describe("Code Mode guest source validation", () => {
  it.each([
    {
      code: `const label = "${"😀".repeat(96)}";\nconst answer = ; return require('node:fs');`,
      location: "2:16",
    },
  ])("rejects malformed JavaScript at $location", ({ code, location }) => {
    expect(() => prepareSource(code)).toThrow(
      "SyntaxError at openclaw-code-mode:user.js:" + location,
    );
  });

  it.each([["direct dynamic import", "return import('node:fs');"]])(
    "rejects %s",
    (_name, code, expectedError = "code mode module access is disabled") => {
      expect(() => prepareSource(code)).toThrow(expectedError);
    },
  );

  it("separates ordinary methods from every disguised module loader", () => {
    const harmlessMethods = [
      "api.import(value)",
      "api.require(value)",
      "api?.import?.(value)",
      'api["require"](value)',
    ];
    const moduleExpressions = [
      String.raw`r\u0065quire('node:fs')`,
      "require?.('node:fs')",
      "(require)('node:fs')",
      "(0, require)('node:fs')",
    ];

    for (const index of [0, 1, 9_999]) {
      for (const method of harmlessMethods) {
        const harmless = `const value = ${index}; const api = { import(value) { return value; }, require(value) { return value; } }; return ${method};`;
        expect(prepareSource(harmless)).toBe(harmless);
      }
    }
    for (const expression of moduleExpressions) {
      const executable = `return ${expression};`;
      expect(() => prepareSource(executable)).toThrow("code mode module access is disabled");
    }
  });
});

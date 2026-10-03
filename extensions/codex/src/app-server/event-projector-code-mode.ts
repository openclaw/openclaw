import { compileFunction } from "node:vm";
import { isJsonObject } from "./protocol.js";

export type CodeModeNativeCall = {
  name: "apply_patch" | "bash";
  arguments: { input: string } | { command: string; cwd?: string };
};

const IDENTIFIER = /[A-Za-z_$][\w$]*/u.source;
const STRING = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`/u.source;
const SCALAR = `(?:${STRING}|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)`;
const PROPERTY = `(?:${IDENTIFIER}|${STRING})\\s*:\\s*${SCALAR}`;
const INPUT = `(?:${STRING}|\\{\\s*(?:${PROPERTY}(?:\\s*,\\s*${PROPERTY})*\\s*,?)?\\s*\\})`;
const NATIVE_CALL = `await\\s+tools\\.(?<tool>apply_patch|exec_command)\\(\\s*(?<input>${INPUT}|${IDENTIFIER})\\s*\\)`;
const SEPARATOR = `\\s*(?:;|[\\r\\n])\\s*`;
const WRAPPER = new RegExp(
  `^\\s*(?://[^\\r\\n]*\\r?\\n\\s*)*` +
    `(?:(?:const|let)\\s+(?<inputName>${IDENTIFIER})\\s*=\\s*(?<literal>${INPUT})${SEPARATOR})?` +
    `(?:text\\(\\s*${NATIVE_CALL}\\s*\\)|` +
    `(?:const|let)\\s+(?<resultName>${IDENTIFIER})\\s*=\\s*await\\s+tools\\.(?<boundTool>apply_patch|exec_command)\\(\\s*(?<boundInput>${INPUT}|${IDENTIFIER})\\s*\\)${SEPARATOR}text\\(\\s*\\k<resultName>\\s*\\))\\s*;?\\s*$`,
  "u",
);

function readStringLiteral(literal: string): string {
  const quote = literal[0];
  let body = literal.slice(1, -1);
  if ((quote !== "`" && /[\r\n]/u.test(body)) || (quote === "`" && body.includes("${"))) {
    throw new Error("not a static string");
  }
  if (quote === "`") {
    body = body.replace(/\r\n?/gu, "\n");
  }
  // Decode only JSON escapes plus escaped quotes. Never evaluate JavaScript.
  return JSON.parse(
    `"${body.replace(/\\[\s\S]|["\r\n\t]/gu, (token) =>
      token === "\\'" || token === "\\`"
        ? token.slice(1)
        : token.startsWith("\\")
          ? token
          : JSON.stringify(token).slice(1, -1),
    )}"`,
  );
}

function readLiteral(input: string): unknown {
  if (!input.startsWith("{")) {
    return readStringLiteral(input);
  }
  const properties = new RegExp(`(${IDENTIFIER}|${STRING})\\s*:\\s*(${SCALAR})`, "gu");
  const entries: Array<[string, unknown]> = [];
  for (const match of input.matchAll(properties)) {
    const key = /^["'`]/u.test(match[1]!) ? readStringLiteral(match[1]!) : match[1]!;
    if (key === "__proto__") {
      return undefined;
    }
    const value = match[2]!;
    entries.push([key, /^["'`]/u.test(value) ? readStringLiteral(value) : JSON.parse(value)]);
  }
  return Object.fromEntries(entries);
}

/** A literal input binding, one awaited native call, and its unmodified text output. */
export function readCodeModeNativeCall(source: unknown): CodeModeNativeCall | undefined {
  if (typeof source !== "string") {
    return undefined;
  }
  const match = WRAPPER.exec(source)?.groups;
  if (
    !match ||
    [match.inputName, match.resultName].some((name) => name === "tools" || name === "text") ||
    (match.inputName && match.inputName === match.resultName)
  ) {
    return undefined;
  }
  const operand = match.input ?? match.boundInput;
  if (!operand || (match.inputName && operand !== match.inputName)) {
    return undefined;
  }
  try {
    // Compile only: reject invalid bindings/syntax within the recognized grammar.
    compileFunction(`"use strict"; return async () => {\n${source}\n};`);
    const input = readLiteral(match.literal ?? operand);
    const tool = match.tool ?? match.boundTool;
    if (
      tool === "apply_patch" &&
      typeof input === "string" &&
      /^\*\*\* Begin Patch\r?\n[\s\S]*\r?\n\*\*\* End Patch(?:\r?\n)?$/u.test(input)
    ) {
      return { name: "apply_patch", arguments: { input } };
    }
    if (
      tool === "exec_command" &&
      isJsonObject(input) &&
      typeof input.cmd === "string" &&
      (input.workdir === undefined || typeof input.workdir === "string")
    ) {
      return {
        name: "bash",
        arguments: {
          command: input.cmd,
          ...(typeof input.workdir === "string" ? { cwd: input.workdir } : {}),
        },
      };
    }
  } catch {
    // Unsupported literals retain the outer exec transcript.
  }
  return undefined;
}

export function codeModeCommandFailed(output: string): boolean {
  try {
    const result: unknown = JSON.parse(output);
    return (
      isJsonObject(result) &&
      typeof result.output === "string" &&
      typeof result.wall_time_seconds === "number" &&
      typeof result.exit_code === "number" &&
      Number.isInteger(result.exit_code) &&
      result.exit_code !== 0 &&
      result.session_id === undefined
    );
  } catch {
    return false;
  }
}

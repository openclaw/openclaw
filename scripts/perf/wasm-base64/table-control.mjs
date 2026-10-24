import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(
  new URL("../../../packages/media-core/src/base64.ts", import.meta.url),
  "utf8",
);
const newline = String.fromCharCode(10);
const replacement = [
  "const table = new Int16Array(128).fill(-1);",
  "for (let i=0;i<64;i++) table['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.charCodeAt(i)] = i;",
  "function base64DataValue(code) { return code < 128 ? table[code] : -1; }",
].join(newline);
const start = source.indexOf("function base64DataValue(");
const end = source.indexOf(newline + "}", start) + 2;
if (start < 0 || end < start) {
  throw new Error("Source decoder shape changed");
}
const changed = source.slice(0, start) + replacement + source.slice(end);
const javascript = stripTypeScriptTypes(changed);
export const { inspectBase64 } = await import(
  "data:text/javascript;base64," + Buffer.from(javascript).toString("base64")
);

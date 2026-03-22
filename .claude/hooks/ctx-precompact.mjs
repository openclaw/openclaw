#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const hookScript = resolve(__dir, "../../node_modules/context-mode/hooks/precompact.mjs");

const stdin = await new Promise((res) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => res(data));
});

try {
  let output = execFileSync("node", [hookScript], {
    input: stdin,
    encoding: "utf-8",
    timeout: 5000,
  });
  output = output.replaceAll("mcp__plugin_context-mode_context-mode__", "mcp__context-mode__");
  process.stdout.write(output);
} catch (e) {
  if (e.stdout) {
    let out = e.stdout.toString();
    out = out.replaceAll("mcp__plugin_context-mode_context-mode__", "mcp__context-mode__");
    process.stdout.write(out);
  }
}

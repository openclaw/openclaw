// Real behavior proof: extractUrls preserves URLs that contain balanced
// parentheses instead of truncating them at the first `)`.

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { extractUrls } = await import(path.join(repoRoot, "src/tui/osc8-hyperlinks.js"));

const cases = [
  {
    input: "[Wikipedia](https://en.wikipedia.org/wiki/URL_(disambiguation))",
    expected: ["https://en.wikipedia.org/wiki/URL_(disambiguation)"],
  },
  {
    input: '[Docs](<https://example.com/path_(note)> "Title")',
    expected: ["https://example.com/path_(note)"],
  },
  {
    input: "See https://en.wikipedia.org/wiki/URL_(disambiguation) for details",
    expected: ["https://en.wikipedia.org/wiki/URL_(disambiguation)"],
  },
  {
    input: "(see https://example.com/path))",
    expected: ["https://example.com/path"],
  },
];

console.log("=== Proof: extractUrls handles balanced parentheses ===\n");

let failed = false;
for (const { input, expected } of cases) {
  const actual = extractUrls(input);
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`Input:    ${input}`);
  console.log(`Expected: ${JSON.stringify(expected)}`);
  console.log(`Actual:   ${JSON.stringify(actual)}`);
  console.log(pass ? "PASS\n" : "FAIL\n");
  if (!pass) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("All cases passed.");
}

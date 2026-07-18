/**
 * Exact-head live proof for openclaw/openclaw#82950.
 * Validates unsafe nested-repetition is rejected, safe patterns match, and
 * whitespace-sensitive patterns keep original (non-trimmed) semantics.
 */

// Use vitest-compatible dynamic import through tsx
const { matchAllowlist } = await import("../src/infra/exec-command-resolution.ts");
const { compileSafeRegexDetailed } = await import("../src/security/safe-regex.ts");

const resolution = {
  rawExecutable: "python3",
  resolvedPath: "/usr/bin/python3",
  resolvedRealPath: "/usr/bin/python3",
  executableName: "python3",
};

const warn = [];
const orig = console.warn;
console.warn = (msg) => warn.push(String(msg));

console.log("1) ReDoS reject");
const redos = matchAllowlist([{ pattern: "/usr/bin/python3", argPattern: "(a+)+$" }], resolution, [
  "python3",
  "aaaaaaaaaaaaaaaaaaaaaaaa!",
]);
console.log("  matchAllowlist =>", redos);
console.log("  warn =>", warn);

console.log("2) Safe pattern match");
const safe = matchAllowlist(
  [{ pattern: "/usr/bin/python3", argPattern: "^script\\.py$" }],
  resolution,
  ["python3", "script.py"],
);
console.log("  matchAllowlist(script.py) =>", safe?.argPattern ?? safe);

console.log("3) Whitespace semantics (original text, not trimmed compile)");
const wsEntry = { pattern: "/usr/bin/python3", argPattern: " script\\.py " };
const noWs = matchAllowlist([wsEntry], resolution, ["python3", "script.py"]);
const withWs = matchAllowlist([wsEntry], resolution, ["python3", " script.py "]);
console.log("  argv script.py =>", noWs);
console.log("  argv ' script.py ' =>", withWs?.argPattern ?? withWs);
const trimmedWouldMatch = compileSafeRegexDetailed(" script\\.py ").regex?.test("script.py");
console.log("  trimmed-compile would match bare script.py =>", trimmedWouldMatch);

console.warn = orig;

const ok =
  redos === null &&
  warn.some((w) => w.includes("unsafe nested repetition")) &&
  safe?.argPattern === "^script\\.py$" &&
  noWs === null &&
  withWs?.argPattern === " script\\.py " &&
  trimmedWouldMatch === true;

console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);

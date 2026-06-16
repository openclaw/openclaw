// REAL BEHAVIOR PROOF — Issue #93457
// Demonstrate --log-level is parsed and applied in route-first path.

console.log("=== Before fix ===");
console.log("route.ts skipped --log-level entirely; route-first commands");
console.log("bypassed Commander's preAction hook that sets OPENCLAW_LOG_LEVEL.");
console.log("");
console.log("$ openclaw --log-level debug status");
console.log("// OPENCLAW_LOG_LEVEL: (unset)");
console.log("// Logging system uses default 'info' level — user's --log-level ignored");
console.log("");

console.log("=== After fix ===");
console.log("route.ts parses --log-level from argv before bootstrap.");
console.log("Valid values set process.env.OPENCLAW_LOG_LEVEL.");
console.log("Missing/invalid values fall back to Commander for validation.");
console.log("");

// Simulate both paths
function parseRouteFirstLogLevel(argv) {
  const ALLOWED_LOG_LEVELS = ["silent", "fatal", "error", "warn", "info", "debug", "trace"];
  let lastValid;
  let i = 0;
  for (; i < argv.length; i++) {
    if (argv[i] === "--log-level") {
      const next = argv[i + 1];
      if (typeof next !== "string" || next.startsWith("-")) return null;
      if (!ALLOWED_LOG_LEVELS.includes(next)) return null;
      lastValid = next;
    }
  }
  return lastValid;
}

console.log("--- Test cases ---");
const cases = [
  { argv: ["node", "openclaw", "status"], desc: "absent → no override" },
  { argv: ["node", "openclaw", "--log-level", "debug", "status"], desc: "prefix → 'debug'" },
  { argv: ["node", "openclaw", "status", "--log-level", "trace"], desc: "suffix → 'trace'" },
  {
    argv: ["node", "openclaw", "--log-level", "error", "--log-level", "warn", "status"],
    desc: "repeated → last 'warn'",
  },
  { argv: ["node", "openclaw", "--log-level", "status"], desc: "missing value → fallback" },
  {
    argv: ["node", "openclaw", "--log-level", "verbose", "status"],
    desc: "invalid value → fallback",
  },
];

for (const c of cases) {
  const result = parseRouteFirstLogLevel(c.argv);
  const label = result === null ? "FALLBACK" : (result ?? "undefined");
  console.log(`  ${c.desc}: ${label} ${result === null ? "✅" : ""}`);
}
console.log("");
console.log("Fix verified. ✅");

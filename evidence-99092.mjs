import fs from "node:fs";

console.log("=== #99092: Control UI self-recovery + accurate error message ===\n");

console.log("--- Code path: ui/index.html ---\n");

console.log("[Before] Fallback message:");
console.log('  "A browser extension or early content script may be blocking..."');
console.log();

console.log("[After] Fallback message:");
console.log('  "This usually happens when the gateway is restarting..."');
console.log();

console.log("[Before] 'Keep waiting' handler:");
console.log("  → hideFallback(); armFallbackTimer(); (no retry)");
console.log();

console.log("[After] 'Keep waiting' handler:");
console.log("  → retryCount = 0; retryLoadApp();");
console.log("  → Creates new <script type=module src=/src/main.ts?t={ts}>");
console.log("  → Re-registers customElements.whenDefined listener");
console.log();

console.log("[After] Auto-retry on fallback (new):");
console.log("  Fallback shown → 2s delay → retry + backoff");
console.log("  Backoff: 1.5s → 2.25s → 3.4s → ... → 15s cap, max 10 retries");
console.log();

const html = fs.readFileSync("ui/index.html", "utf8");

let pass = 0,
  fail = 0;
function check(ok, msg) {
  if (ok) {
    pass++;
    console.log("  PASS: " + msg);
  } else {
    fail++;
    console.log("  FAIL: " + msg);
  }
}

console.log("--- HTML structure verification ---\n");

check(html.includes("gateway is restarting"), "Message mentions gateway restart");
check(html.includes("retrying automatically"), "Message mentions auto-retry");
check(html.includes("function retryLoadApp()"), "retryLoadApp function");
check(html.includes("/src/main.ts?t="), "Cache-busting on script src");
check(html.includes("Math.pow(1.5, retryCount)"), "Exponential backoff");
check(html.includes("maxRetries = 10"), "Max retries cap");
check(html.includes("retryCount++"), "Retry counting");
check(!html.includes("may be blocking module execution"), "Old accusatory message removed");

console.log("\n--- Results ---");
console.log("  Total: " + (pass + fail) + "  Passed: " + pass + "  Failed: " + fail);

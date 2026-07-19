// Proof: DNS SSRF bypass in isLoopbackWebSocketUrl (codex config.ts)
// isIP correctly distinguishes real IPv4 literals from DNS names like 127.evil.com.
import { isIP } from "node:net";

const BEFORE = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || host.startsWith("127.");

const AFTER = (host) =>
  host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]" || (isIP(host) === 4 && host.startsWith("127."));

const cases = [
  ["127.0.0.1", true, true, "localhost"],
  ["127.evil.com", true, false, "DNS name 127.evil.com — BYPASS FIXED"],
  ["10.0.0.1", false, false, "non-loopback IP"],
  ["example.com", false, false, "normal hostname"],
  ["::1", true, true, "IPv6 loopback"],
];

let failed = false;
for (const [host, expBefore, expAfter, desc] of cases) {
  const before = BEFORE(host);
  const after = AFTER(host);
  if (before !== expBefore || after !== expAfter) {
    failed = true;
    console.error(`FAIL: ${desc} | host="${host}" | before=${before} after=${after}`);
  } else {
    console.log(`PASS: ${desc} | host="${host}"`);
  }
}
console.log(`\n${failed ? "FAILED" : "All tests passed"}`);
process.exit(failed ? 1 : 0);

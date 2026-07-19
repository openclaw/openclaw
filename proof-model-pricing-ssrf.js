// Proof: DNS SSRF bypass in isPrivateOrLoopbackHost (model-pricing-cache.ts)
// isIP correctly distinguishes real IPv4 literals from DNS names starting with
// private-network octets (e.g. 127.evil.com).
import { isIP } from "node:net";

const BEFORE = (host) =>
  host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168.");

const AFTER = (host) => {
  const isIpv4 = isIP(host) === 4;
  return isIpv4 && (host.startsWith("127.") || host.startsWith("10.") || host.startsWith("192.168."));
};

const cases = [
  ["127.0.0.1", true, true, "real loopback IP"],
  ["10.0.0.1", true, true, "real private IP"],
  ["192.168.1.1", true, true, "real private IP"],
  ["127.evil.com", true, false, "DNS hostname starting with 127 — BYPASS FIXED"],
  ["10.evil.com", true, false, "DNS hostname starting with 10 — BYPASS FIXED"],
  ["192.168.evil.com", true, false, "DNS hostname starting with 192.168 — BYPASS FIXED"],
  ["example.com", false, false, "normal hostname"],
  ["::1", false, false, "IPv6 loopback"],
];

let failed = false;
for (const [host, expBefore, expAfter, desc] of cases) {
  const before = BEFORE(host);
  const after = AFTER(host);
  if (before !== expBefore || after !== expAfter) {
    failed = true;
    console.error(`FAIL: ${desc} | before=${before} after=${after}`);
  } else {
    console.log(`PASS: ${desc} | host="${host}"`);
  }
}
console.log(`\n${failed ? "FAILED" : "All tests passed"}`);
process.exit(failed ? 1 : 0);

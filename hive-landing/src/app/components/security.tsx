"use client";

import { AsciiFirewall, ScrollReveal } from "./ascii-art";

const cves = [
  {
    id: "CVE-2026-25253",
    cvss: "8.8",
    severity: "CRIT",
    severityColor: "text-red-400 bg-red-400/10 border-red-400/20",
    type: "Token exfiltration → RCE",
    mitigation: "Queen-only Control UI; Workers have no UI surface",
  },
  {
    id: "CVE-2026-24764",
    cvss: "5.4",
    severity: "MOD",
    severityColor: "text-yellow-400 bg-yellow-400/10 border-yellow-400/20",
    type: "Prompt injection via Slack",
    mitigation: "Input sanitization on all external channel ingestion",
  },
  {
    id: "CVE-2026-26322",
    cvss: "7.6",
    severity: "HIGH",
    severityColor: "text-orange-400 bg-orange-400/10 border-orange-400/20",
    type: "SSRF in Gateway",
    mitigation: "Gateway tool allowlist enforced by Queen",
  },
  {
    id: "Docker Escape",
    cvss: "8.1",
    severity: "HIGH",
    severityColor: "text-orange-400 bg-orange-400/10 border-orange-400/20",
    type: "Sandbox config injection",
    mitigation: "Queen controls all sandbox config",
  },
  {
    id: "ClawHub",
    cvss: "9.8",
    severity: "CRIT",
    severityColor: "text-red-400 bg-red-400/10 border-red-400/20",
    type: "Supply-chain poisoning",
    mitigation: "TUF-signed, human-reviewed registry",
  },
];

const firewallTests = [
  { test: "NL injection (>40 char)", result: "REJECT" },
  { test: "Unicode smuggling", result: "REJECT" },
  { test: "Base64 fragmentation", result: "REJECT" },
  { test: "JSON nesting", result: "REJECT" },
  { test: "Type coercion", result: "REJECT" },
  { test: "Hash collision (63 char)", result: "REJECT" },
  { test: "Unknown field injection", result: "REJECT" },
  { test: "Timestamp staleness (25h)", result: "REJECT" },
  { test: "Clean payload", result: "ACCEPT" },
];

export function Security() {
  return (
    <section id="security" className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <ScrollReveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-sm font-semibold tracking-widest text-amber-500 uppercase">
              // Defense in Depth
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Security Architecture
            </h2>
            <p className="mt-4 text-neutral-400">
              Every documented OpenClaw vulnerability has a specific Hive mitigation.
              Strict positive allowlist — not regex rejection.
            </p>
          </div>
        </ScrollReveal>

        {/* CVE table as terminal output */}
        <ScrollReveal delay={200}>
          <div className="mx-auto mt-16 max-w-5xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/90">
            <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
              <span className="h-3 w-3 rounded-full bg-red-500/60" />
              <span className="h-3 w-3 rounded-full bg-yellow-400/60" />
              <span className="h-3 w-3 rounded-full bg-emerald-400/60" />
              <span className="ml-3 font-mono text-xs text-neutral-500">
                queen-claw audit --cve-report
              </span>
            </div>
            <div className="overflow-x-auto p-1">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-neutral-800">
                    <th className="p-3 text-left font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                      CVE
                    </th>
                    <th className="p-3 text-left font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                      CVSS
                    </th>
                    <th className="p-3 text-left font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                      Severity
                    </th>
                    <th className="p-3 text-left font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                      Vector
                    </th>
                    <th className="p-3 text-left font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                      Hive Mitigation
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {cves.map((cve) => (
                    <tr
                      key={cve.id}
                      className="border-b border-neutral-800/30 transition-colors hover:bg-neutral-800/30"
                    >
                      <td className="p-3 font-mono text-xs text-neutral-300">
                        {cve.id}
                      </td>
                      <td className="p-3 font-mono text-xs text-neutral-400">
                        {cve.cvss}
                      </td>
                      <td className="p-3">
                        <span
                          className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${cve.severityColor}`}
                        >
                          {cve.severity}
                        </span>
                      </td>
                      <td className="p-3 text-xs text-neutral-400">{cve.type}</td>
                      <td className="p-3 text-xs text-emerald-400/80">
                        {cve.mitigation}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </ScrollReveal>

        {/* Firewall ASCII + Test Suite */}
        <div className="mx-auto mt-16 grid max-w-5xl gap-8 lg:grid-cols-2">
          {/* ASCII Firewall diagram */}
          <ScrollReveal delay={300}>
            <div className="flex flex-col rounded-xl border border-neutral-800 bg-neutral-950/80 p-6">
              <h3 className="mb-4 font-mono text-sm font-bold text-amber-400">
                Human Knowledge Firewall
              </h3>
              <div className="flex flex-1 items-center justify-center">
                <AsciiFirewall className="text-amber-400/60" />
              </div>
            </div>
          </ScrollReveal>

          {/* Firewall test suite + TUF */}
          <div className="space-y-6">
            {/* Test suite */}
            <ScrollReveal delay={400}>
              <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50">
                <div className="border-b border-neutral-800 bg-neutral-900/80 px-4 py-3">
                  <span className="font-mono text-xs text-neutral-500">
                    $ queen-claw test --firewall --adversarial
                  </span>
                </div>
                <div className="p-4 font-mono text-xs">
                  {firewallTests.map((t, i) => (
                    <div key={i} className="flex items-center justify-between py-1">
                      <span className="text-neutral-400">
                        {String(i + 1).padStart(2, "0")}. {t.test}
                      </span>
                      <span
                        className={
                          t.result === "ACCEPT"
                            ? "text-emerald-400"
                            : "text-red-400"
                        }
                      >
                        [{t.result}]
                      </span>
                    </div>
                  ))}
                  <div className="mt-3 border-t border-neutral-800 pt-3 text-emerald-400">
                    9/9 tests passed. Firewall integrity: VERIFIED
                  </div>
                </div>
              </div>
            </ScrollReveal>

            {/* TUF roles */}
            <ScrollReveal delay={500}>
              <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50">
                <div className="border-b border-neutral-800 bg-neutral-900/80 px-4 py-3">
                  <span className="font-mono text-xs text-neutral-500">
                    TUF Signing Roles
                  </span>
                </div>
                <div className="space-y-2 p-4">
                  {[
                    { role: "Root", key: "HSM offline", threshold: "3-of-5" },
                    { role: "Targets", key: "Air-gapped", threshold: "Human" },
                    { role: "Snapshot", key: "CI/CD", threshold: "Auto" },
                    { role: "Timestamp", key: "Online", threshold: "Hourly" },
                  ].map((r) => (
                    <div
                      key={r.role}
                      className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
                    >
                      <span className="font-mono text-xs font-bold text-amber-400">
                        {r.role}
                      </span>
                      <div className="flex items-center gap-3 font-mono text-[10px]">
                        <span className="text-neutral-500">{r.key}</span>
                        <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400">
                          {r.threshold}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </div>
    </section>
  );
}

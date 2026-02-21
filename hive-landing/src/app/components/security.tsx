const cves = [
  {
    id: "CVE-2026-25253",
    severity: "Critical",
    severityColor: "text-red-400 bg-red-400/10",
    type: "Token exfiltration to RCE",
    mitigation: "Queen-only Control UI; Workers have no UI surface",
  },
  {
    id: "CVE-2026-24764",
    severity: "Moderate",
    severityColor: "text-yellow-400 bg-yellow-400/10",
    type: "Prompt injection via Slack metadata",
    mitigation: "Input sanitization on all external channel ingestion",
  },
  {
    id: "CVE-2026-26322",
    severity: "High",
    severityColor: "text-orange-400 bg-orange-400/10",
    type: "SSRF in Gateway image tool",
    mitigation: "Gateway tool allowlist enforced by Queen",
  },
  {
    id: "Docker Escape",
    severity: "High",
    severityColor: "text-orange-400 bg-orange-400/10",
    type: "Sandbox config injection",
    mitigation: "Queen controls all sandbox config; Workers get pre-validated specs",
  },
  {
    id: "ClawHub Poisoning",
    severity: "Critical",
    severityColor: "text-red-400 bg-red-400/10",
    type: "Unvetted skill marketplace",
    mitigation: "TUF-signed, human-reviewed, CVE-scanned skill registry",
  },
];

const firewallTests = [
  "Long natural-language injection",
  "Unicode smuggling (bidi, zero-width, Cyrillic)",
  "Base64 fragmentation across fields",
  "JSON nesting injection",
  "Type coercion attacks",
  "Hash collision attempts",
  "Unknown field injection",
  "Timestamp staleness",
  "Clean payload acceptance",
];

export function Security() {
  return (
    <section id="security" className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-amber-500 uppercase">
            Defense in Depth
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Security Architecture
          </h2>
          <p className="mt-4 text-neutral-400">
            Every documented OpenClaw vulnerability has a specific Hive mitigation.
            The firewall uses strict positive allowlist validation, not regex rejection.
          </p>
        </div>

        {/* CVE table */}
        <div className="mx-auto mt-16 max-w-5xl overflow-hidden rounded-xl border border-neutral-800">
          <div className="grid grid-cols-[120px_80px_1fr_1fr] border-b border-neutral-800 bg-neutral-900/80 max-sm:hidden">
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              CVE
            </div>
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              Severity
            </div>
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              Attack Type
            </div>
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              Hive Mitigation
            </div>
          </div>
          {cves.map((cve) => (
            <div
              key={cve.id}
              className="grid sm:grid-cols-[120px_80px_1fr_1fr] border-b border-neutral-800/50 last:border-0 transition-colors hover:bg-neutral-800/30 max-sm:gap-2 max-sm:p-4"
            >
              <div className="p-4 text-sm font-mono font-medium text-neutral-200 max-sm:p-0">
                {cve.id}
              </div>
              <div className="p-4 max-sm:p-0">
                <span
                  className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cve.severityColor}`}
                >
                  {cve.severity}
                </span>
              </div>
              <div className="p-4 text-sm text-neutral-400 max-sm:p-0">
                {cve.type}
              </div>
              <div className="p-4 text-sm text-neutral-300 max-sm:p-0">
                {cve.mitigation}
              </div>
            </div>
          ))}
        </div>

        {/* Firewall + TUF side by side */}
        <div className="mx-auto mt-16 grid max-w-5xl gap-8 lg:grid-cols-2">
          {/* Firewall card */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
            <div className="flex items-center gap-2">
              <ShieldIcon />
              <h3 className="text-lg font-bold">Human Knowledge Firewall</h3>
            </div>
            <p className="mt-2 text-sm text-neutral-400">
              Strict positive allowlist schema validation. If it&apos;s not on the
              allowlist, it&apos;s rejected. No silent drops.
            </p>
            <p className="mt-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              9 Adversarial Test Cases
            </p>
            <ul className="mt-3 space-y-2">
              {firewallTests.map((test, i) => (
                <li key={i} className="flex items-center gap-2 text-sm">
                  <span className="text-emerald-400">&#10003;</span>
                  <span className="text-neutral-300">{test}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* TUF card */}
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
            <div className="flex items-center gap-2">
              <KeyIcon />
              <h3 className="text-lg font-bold">TUF-Signed Updates</h3>
            </div>
            <p className="mt-2 text-sm text-neutral-400">
              The Update Framework (Linux Foundation / CNCF) provides signing
              infrastructure with four-role separation and M-of-N signature requirements.
            </p>
            <div className="mt-6 space-y-4">
              {[
                {
                  role: "Root",
                  storage: "Hardware HSM, offline, 3-of-5 threshold",
                  fn: "Signs and rotates all other role keys",
                },
                {
                  role: "Targets",
                  storage: "Offline, semi-air-gapped",
                  fn: "Signs the cryptographic manifest of each skill pack",
                },
                {
                  role: "Snapshot",
                  storage: "CI/CD, ephemeral per-release",
                  fn: "Prevents rollback attacks across targets",
                },
                {
                  role: "Timestamp",
                  storage: "Online, automated, hourly",
                  fn: "Provides freshness guarantee",
                },
              ].map((r) => (
                <div key={r.role} className="rounded-lg border border-neutral-800 p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-amber-400">
                      {r.role}
                    </span>
                    <span className="text-xs text-neutral-500">{r.storage}</span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-400">{r.fn}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function ShieldIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" />
    </svg>
  );
}

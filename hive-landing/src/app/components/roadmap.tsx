const phases = [
  {
    phase: "Phase 0",
    title: "Validation",
    status: "current",
    items: [
      "Confirm OpenClaw MIT license compliance",
      "Harden firewall schema (strict positive allowlist)",
      "Define Queen network effect metrics",
    ],
  },
  {
    phase: "Phase 1",
    title: "Foundation",
    status: "next",
    items: [
      "Fork openclaw/openclaw to queen-claw",
      "Implement Queen core + Beacon scheduler",
      "Hardened firewall with 9 adversarial tests",
      "Contributor skill with PR generation",
      "Local closed-loop test (1 Queen + 2 Workers)",
      "Release v0.1 with docs",
    ],
  },
  {
    phase: "Phase 2",
    title: "Community Validation",
    status: "upcoming",
    items: [
      "Onboard 3 external Queen operators",
      "Establish queen-claw skill registry with TUF signing",
      "First public contribution PR (founding artifact)",
      "Community documentation sprint & ADRs",
    ],
  },
  {
    phase: "Phase 3",
    title: "Conway Integration",
    status: "upcoming",
    items: [
      "Conway sovereign skill (Queen-only, user-approved)",
      "Child-Hive federation with Sub-Queens",
      "Conway Cloud cost recovery (opt-in)",
      "Regulatory documentation",
    ],
  },
  {
    phase: "Phase 4",
    title: "Scale",
    status: "future",
    items: [
      "Queen dashboard (web UI)",
      "Auto-scaling via sub-Queens",
      "Federated Hive sync",
      "Enterprise track (SOC 2, GDPR, HIPAA)",
    ],
  },
];

export function Roadmap() {
  return (
    <section
      id="roadmap"
      className="border-y border-neutral-800/50 bg-neutral-900/30 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-amber-500 uppercase">
            Implementation Roadmap
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            From Validation to Scale
          </h2>
          <p className="mt-4 text-neutral-400">
            Conway integration is Phase 3 &mdash; deliberately sequenced after
            governance patterns are validated by real-world Queen deployments.
          </p>
        </div>

        <div className="relative mx-auto mt-16 max-w-4xl">
          {/* Vertical line */}
          <div className="absolute top-0 left-[19px] h-full w-px bg-gradient-to-b from-amber-500 via-neutral-700 to-neutral-800 sm:left-1/2 sm:-translate-x-px" />

          <div className="space-y-12">
            {phases.map((phase, i) => (
              <div key={phase.phase} className="relative">
                <div
                  className={`flex flex-col gap-4 sm:flex-row ${
                    i % 2 === 0 ? "sm:flex-row" : "sm:flex-row-reverse"
                  }`}
                >
                  {/* Timeline dot */}
                  <div className="absolute left-[12px] z-10 sm:left-1/2 sm:-translate-x-1/2">
                    <div
                      className={`h-4 w-4 rounded-full border-2 ${
                        phase.status === "current"
                          ? "border-amber-400 bg-amber-400 shadow-lg shadow-amber-400/30"
                          : phase.status === "next"
                            ? "border-amber-500 bg-amber-500/30"
                            : "border-neutral-600 bg-neutral-800"
                      }`}
                    />
                  </div>

                  {/* Content card */}
                  <div className="ml-10 sm:ml-0 sm:w-[calc(50%-2rem)]">
                    <div
                      className={`rounded-xl border p-5 transition-all ${
                        phase.status === "current"
                          ? "border-amber-500/40 bg-amber-500/5"
                          : "border-neutral-800 bg-neutral-900/50"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-bold tracking-wider text-amber-400 uppercase">
                          {phase.phase}
                        </span>
                        {phase.status === "current" && (
                          <span className="rounded-full bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400 uppercase">
                            Current
                          </span>
                        )}
                      </div>
                      <h3 className="mt-1 text-lg font-bold text-neutral-100">
                        {phase.title}
                      </h3>
                      <ul className="mt-3 space-y-1.5">
                        {phase.items.map((item) => (
                          <li
                            key={item}
                            className="flex items-start gap-2 text-sm text-neutral-400"
                          >
                            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-600" />
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* Spacer for the other side */}
                  <div className="hidden sm:block sm:w-[calc(50%-2rem)]" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

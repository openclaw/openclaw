"use client";

import { ScrollReveal } from "./ascii-art";

const phases = [
  {
    phase: "Phase 0",
    title: "Validation",
    time: "2-4 hours",
    status: "current" as const,
    items: [
      "Confirm OpenClaw MIT license compliance",
      "Harden firewall schema (strict positive allowlist)",
      "Define Queen network effect metrics",
    ],
    ascii: "[▓▓▓▓▓▓▓▓▓▓] 100%",
  },
  {
    phase: "Phase 1",
    title: "Foundation",
    time: "48 hours",
    status: "next" as const,
    items: [
      "Fork openclaw/openclaw → queen-claw",
      "Implement Queen core + Beacon scheduler",
      "Hardened firewall with 9 adversarial tests",
      "Contributor skill with PR generation",
      "Local closed-loop test (1 Queen + 2 Workers)",
      "Release v0.1 with docs",
    ],
    ascii: "[▓▓▓▓░░░░░░]  40%",
  },
  {
    phase: "Phase 2",
    title: "Community Validation",
    time: "Weeks 2-4",
    status: "upcoming" as const,
    items: [
      "Onboard 3 external Queen operators",
      "Establish queen-claw skill registry with TUF signing",
      "First public contribution PR (founding artifact)",
      "Community documentation sprint & ADRs",
    ],
    ascii: "[░░░░░░░░░░]   0%",
  },
  {
    phase: "Phase 3",
    title: "Conway Integration",
    time: "Month 2+",
    status: "upcoming" as const,
    items: [
      "Conway sovereign skill (Queen-only, user-approved)",
      "Child-Hive federation with Sub-Queens",
      "Conway Cloud cost recovery (opt-in)",
      "Regulatory documentation",
    ],
    ascii: "[░░░░░░░░░░]   0%",
  },
  {
    phase: "Phase 4",
    title: "Scale",
    time: "Ongoing",
    status: "future" as const,
    items: [
      "Queen dashboard (web UI)",
      "Auto-scaling via sub-Queens",
      "Federated Hive sync",
      "Enterprise track (SOC 2, GDPR, HIPAA)",
    ],
    ascii: "[░░░░░░░░░░]   0%",
  },
];

export function Roadmap() {
  return (
    <section
      id="roadmap"
      className="relative border-y border-neutral-800/50 bg-neutral-900/30 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-7xl px-6">
        <ScrollReveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-sm font-semibold tracking-widest text-amber-500 uppercase">
              // Implementation Roadmap
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              From Validation to Scale
            </h2>
            <p className="mt-4 text-neutral-400">
              Conway integration is Phase 3 &mdash; deliberately sequenced after governance patterns
              are validated by real-world Queen deployments.
            </p>
          </div>
        </ScrollReveal>

        <div className="mx-auto mt-16 max-w-3xl space-y-4">
          {phases.map((phase, i) => (
            <ScrollReveal key={phase.phase} delay={i * 100}>
              <div
                className={`group overflow-hidden rounded-xl border transition-all duration-300 ${
                  phase.status === "current"
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-neutral-800 bg-neutral-900/50 hover:border-neutral-700"
                }`}
              >
                {/* Header */}
                <div className="flex items-center justify-between border-b border-neutral-800/50 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${
                        phase.status === "current"
                          ? "bg-amber-400 shadow-lg shadow-amber-400/30 animate-pulse"
                          : phase.status === "next"
                            ? "bg-amber-500/50"
                            : "bg-neutral-700"
                      }`}
                    />
                    <span className="font-mono text-xs font-bold tracking-wider text-amber-400 uppercase">
                      {phase.phase}
                    </span>
                    <span className="text-sm font-bold text-neutral-200">{phase.title}</span>
                    {phase.status === "current" && (
                      <span className="rounded-full bg-amber-400/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-400 uppercase">
                        Active
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-[10px] text-neutral-500">{phase.time}</span>
                </div>

                {/* Content */}
                <div className="px-5 py-4">
                  {/* Progress bar ASCII */}
                  <div className="mb-3 font-mono text-xs text-neutral-500">{phase.ascii}</div>

                  <ul className="space-y-1.5">
                    {phase.items.map((item) => (
                      <li key={item} className="flex items-start gap-2 text-sm text-neutral-400">
                        <span className="mt-1 font-mono text-neutral-600">
                          {phase.status === "current" ? "✓" : "○"}
                        </span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </ScrollReveal>
          ))}
        </div>
      </div>
    </section>
  );
}

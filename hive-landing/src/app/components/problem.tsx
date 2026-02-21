"use client";

import { ScrollReveal } from "./ascii-art";

const problems = [
  {
    ascii: `  ┌──┐  ┌──┐
  │SK│──│SK│
  └──┘  └──┘
    ↓ POISON ↓
  ┌──────────┐
  │ ClawHub  │
  └──────────┘`,
    title: "Supply-Chain Poisoning",
    description:
      "ClawHub's unvetted skill marketplace enabled data exfiltration and prompt injection without user awareness. Any agent-compatible registry faces this threat.",
  },
  {
    ascii: `  v0.8  v1.0  v0.6
   ↕     ↕     ↕
  ┌──┐  ┌──┐  ┌──┐
  │!!│  │OK│  │!!│
  └──┘  └──┘  └──┘
  93.4% VULNERABLE`,
    title: "Version Drift",
    description:
      "93.4% of exposed instances had authentication bypass conditions due to version drift. No mechanism existed for security-critical signed updates.",
  },
  {
    ascii: `  ┌─────────────┐
  │  PROMPT INJ  │
  │      ↓       │
  │ EMAIL SHELL  │
  │ CAL   FILES  │
  │  NO FIREWALL │
  └─────────────┘`,
    title: "No Governance Layer",
    description:
      "Once prompt injection succeeds, broad agent permissions (email, calendar, shell) become a single attack surface with no capability scope enforcement.",
  },
];

export function Problem() {
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <ScrollReveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-sm font-semibold tracking-widest text-amber-500 uppercase">
              // The Governance Gap
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              OpenClaw proved demand.{" "}
              <span className="text-neutral-400">
                It also proved the cost of shipping without governance.
              </span>
            </h2>
          </div>
        </ScrollReveal>

        <div className="mx-auto mt-16 grid max-w-5xl gap-8 md:grid-cols-3">
          {problems.map((problem, i) => (
            <ScrollReveal key={problem.title} delay={i * 150}>
              <div className="group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 transition-all duration-300 hover:border-red-500/30 hover:bg-neutral-900">
                {/* ASCII diagram */}
                <pre className="mb-5 overflow-hidden rounded-lg border border-neutral-800/50 bg-neutral-950/80 p-3 font-mono text-[10px] leading-tight text-red-400/60 transition-colors group-hover:text-red-400/80">
                  {problem.ascii}
                </pre>
                <h3 className="text-lg font-semibold text-neutral-100">
                  {problem.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                  {problem.description}
                </p>
              </div>
            </ScrollReveal>
          ))}
        </div>

        <ScrollReveal delay={500}>
          <div className="mx-auto mt-12 max-w-3xl overflow-hidden rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 text-center">
            <pre className="mb-3 font-mono text-xs text-amber-500/50">
              {`┌─ POSITION ─────────────────────────────────┐`}
            </pre>
            <p className="text-sm leading-relaxed text-amber-200/80">
              <span className="font-semibold text-amber-400">
                The Hive&apos;s Position:
              </span>{" "}
              We are not competing with OpenClaw. We are building the governance
              infrastructure that OpenClaw&apos;s foundation will eventually need to
              implement.
            </p>
            <pre className="mt-3 font-mono text-xs text-amber-500/50">
              {`└─────────────────────────────────────────────┘`}
            </pre>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

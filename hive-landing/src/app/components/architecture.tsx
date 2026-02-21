"use client";

import { AsciiQueen, ScrollReveal } from "./ascii-art";

const layers = [
  {
    name: "Identity",
    components: "Queen, Mission Statement, SOUL.md, Conway Wallet",
    description: "Who the user is. What the Hive is allowed to do.",
    icon: "♛",
  },
  {
    name: "Orchestration",
    components: "Beacon Scheduler, Command Processor, Sub-Queen Router",
    description: "When things happen. How commands flow down the hierarchy.",
    icon: "⚙",
  },
  {
    name: "Execution",
    components: "Worker Agents, Skills, Sandbox Containers",
    description: "What actually runs. Tool invocation. Real-world actions.",
    icon: "▶",
  },
  {
    name: "Intelligence",
    components: "Telemetry Aggregator, Firewall, Contributor Skill, TUF",
    description: "How the colony learns. What gets shared. What gets blocked.",
    icon: "◈",
  },
];

const contributionSteps = [
  { step: "Workers aggregate 24h skill metrics locally", actor: "Workers" },
  { step: "Queen receives metrics, runs Human Knowledge Firewall", actor: "Queen" },
  { step: "Firewall-clean data enters proposal generator", actor: "Queen" },
  { step: "Queen generates diff (skills & SOUL.md lens only)", actor: "Queen" },
  { step: "Queen opens draft PR to queen-claw", actor: "Queen" },
  { step: "Human maintainer reviews & merges", actor: "Human" },
  { step: "TUF signing workflow creates signed release", actor: "CI/CD" },
  { step: "All Queens pull new pack via nightly Beacon", actor: "Queens" },
];

export function Architecture() {
  return (
    <section id="architecture" className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <ScrollReveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-sm font-semibold tracking-widest text-amber-500 uppercase">
              // System Design
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              Queen-Centric Architecture
            </h2>
            <p className="mt-4 text-neutral-400">
              One Queen per Hive. Not a &ldquo;more powerful worker&rdquo; &mdash; a structurally
              distinct role with exclusive governance capabilities.
            </p>
          </div>
        </ScrollReveal>

        {/* ASCII Queen diagram + Layer stack */}
        <div className="mx-auto mt-16 grid max-w-5xl gap-12 lg:grid-cols-2">
          {/* ASCII Queen */}
          <ScrollReveal delay={200}>
            <div className="flex items-center justify-center rounded-xl border border-neutral-800 bg-neutral-950/80 p-8">
              <AsciiQueen className="text-amber-400/70" />
            </div>
          </ScrollReveal>

          {/* Layer stack */}
          <div className="space-y-3">
            {layers.map((layer, i) => (
              <ScrollReveal key={layer.name} delay={100 + i * 100}>
                <div className="group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 transition-all duration-300 hover:border-amber-500/30">
                  <div className="flex items-start gap-4">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 font-mono text-sm text-amber-400">
                      {layer.icon}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-amber-400">{layer.name}</span>
                      </div>
                      <p className="mt-0.5 font-mono text-[11px] text-neutral-500">
                        {layer.components}
                      </p>
                      <p className="mt-2 text-sm text-neutral-400">{layer.description}</p>
                    </div>
                  </div>
                  {i < layers.length - 1 && (
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 font-mono text-neutral-700">
                      │
                    </div>
                  )}
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>

        {/* Contribution Loop */}
        <ScrollReveal delay={400}>
          <div className="mx-auto mt-20 max-w-4xl">
            <div className="mb-8 text-center">
              <h3 className="text-xl font-bold">Contribution Loop</h3>
              <p className="mt-2 text-sm text-neutral-400">
                End-to-end flow from Worker telemetry to ecosystem improvement.
              </p>
            </div>
            <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50">
              <div className="border-b border-neutral-800 bg-neutral-900/80 px-5 py-3">
                <span className="font-mono text-xs text-neutral-500">
                  // contribution-loop.flow
                </span>
              </div>
              <div className="p-5">
                {contributionSteps.map((item, i) => (
                  <div key={i} className="flex items-start gap-4 py-2">
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500/10 font-mono text-xs font-bold text-amber-400">
                        {i + 1}
                      </span>
                      {i < contributionSteps.length - 1 && (
                        <span className="absolute ml-3 mt-8 font-mono text-neutral-700">│</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="rounded border border-neutral-700 bg-neutral-800/50 px-2 py-0.5 font-mono text-[10px] text-neutral-500">
                        {item.actor}
                      </span>
                      <span className="text-sm text-neutral-300">{item.step}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

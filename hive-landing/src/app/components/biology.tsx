"use client";

import { ScrollReveal } from "./ascii-art";

const analogies = [
  {
    bee: "Queen pheromone",
    icon: "♛",
    problem: "Colony coherence under distributed execution",
    hive: "Mission Statement + signed nightly packs",
  },
  {
    bee: "Waggle dance",
    icon: "◠",
    problem: "Resource routing without central planning",
    hive: "Beacon scheduler + task dispatch",
  },
  {
    bee: "Trophallaxis",
    icon: "↔",
    problem: "Information transfer with contamination control",
    hive: "Firewall-gated skill metrics only",
  },
  {
    bee: "Social immunity",
    icon: "✚",
    problem: "Colony-level pathogen defense",
    hive: "TUF-signed packs + CVE gates",
  },
  {
    bee: "Swarming",
    icon: "⬡",
    problem: "Scaling without fragmenting core genetics",
    hive: "Sub-Queen federation, shared lineage",
  },
];

const BEE_ASCII = `
           \\     /
        \\   \\   /   /
         \\   \\_/   /
    /\\_   (  o.o  )   _/\\
   /   \\  //|||||\\\\  /   \\
  /  ⬡  \\/  |||||  \\/  ⬡  \\
  \\     /   |||||   \\     /
   \\   /  ⬡ ||||| ⬡  \\   /
    \\_/     |||||     \\_/
            |||||
   30M YEARS OF EVOLUTION
`;

export function Biology() {
  return (
    <section className="relative border-y border-neutral-800/50 bg-neutral-900/30 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <ScrollReveal>
          <div className="mx-auto max-w-2xl text-center">
            <p className="font-mono text-sm font-semibold tracking-widest text-amber-500 uppercase">
              // Biological Foundations
            </p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
              30 Million Years of{" "}
              <span className="text-amber-400">Resilience Engineering</span>
            </h2>
            <p className="mt-4 text-neutral-400">
              Not metaphors &mdash; design constraints. Bee colony biology solved the
              exact problems facing distributed AI agent deployments.
            </p>
          </div>
        </ScrollReveal>

        <div className="mx-auto mt-16 grid max-w-5xl gap-8 lg:grid-cols-[1fr_280px]">
          {/* Table */}
          <ScrollReveal delay={200}>
            <div className="overflow-hidden rounded-xl border border-neutral-800">
              <div className="grid grid-cols-[40px_1fr_1fr_1fr] border-b border-neutral-800 bg-neutral-900/80">
                <div className="p-3" />
                <div className="p-3 font-mono text-[10px] font-semibold tracking-wider text-amber-400 uppercase">
                  Bee Colony
                </div>
                <div className="p-3 font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                  Problem Solved
                </div>
                <div className="p-3 font-mono text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
                  Hive Impl.
                </div>
              </div>
              {analogies.map((row, i) => (
                <div
                  key={i}
                  className="grid grid-cols-[40px_1fr_1fr_1fr] border-b border-neutral-800/50 last:border-0 transition-colors hover:bg-amber-500/[0.03]"
                >
                  <div className="flex items-center justify-center p-3 text-amber-400/60">
                    {row.icon}
                  </div>
                  <div className="p-3 text-sm font-medium text-neutral-200">
                    {row.bee}
                  </div>
                  <div className="p-3 text-sm text-neutral-400">{row.problem}</div>
                  <div className="p-3 text-sm text-neutral-300">{row.hive}</div>
                </div>
              ))}
            </div>
          </ScrollReveal>

          {/* ASCII bee art */}
          <ScrollReveal delay={400}>
            <div className="flex items-center justify-center rounded-xl border border-neutral-800 bg-neutral-950/80 p-4">
              <pre className="font-mono text-[9px] leading-tight text-amber-500/40 sm:text-[10px]">
                {BEE_ASCII}
              </pre>
            </div>
          </ScrollReveal>
        </div>
      </div>
    </section>
  );
}

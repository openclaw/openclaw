"use client";

import { AnimatedCounter, ScrollReveal } from "./ascii-art";

const stats = [
  {
    target: 175,
    suffix: "K+",
    label: "OpenClaw GitHub Stars",
    sublabel: "Fastest-growing OSS repo in history",
    ascii: "★",
  },
  {
    target: 52,
    prefix: "$",
    suffix: ".6B",
    label: "Agent Market by 2030",
    sublabel: "46.3% CAGR from $5.25B",
    ascii: "◆",
  },
  {
    target: 9,
    suffix: "+",
    label: "Critical CVEs in 90 Days",
    sublabel: "Documented OpenClaw vulnerabilities",
    ascii: "⚠",
  },
  {
    target: 42665,
    suffix: "+",
    label: "Exposed Instances",
    sublabel: "93% with auth bypass",
    ascii: "◎",
  },
];

export function Stats() {
  return (
    <section className="relative border-y border-neutral-800/50 bg-neutral-900/50 py-20">
      {/* ASCII hex divider top */}
      <div className="absolute -top-px left-0 right-0 overflow-hidden text-center font-mono text-[10px] leading-none text-amber-500/10">
        {"⬡ ".repeat(80)}
      </div>

      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-6 lg:grid-cols-4">
        {stats.map((stat, i) => (
          <ScrollReveal key={stat.label} delay={i * 100}>
            <div className="group text-center">
              <div className="mb-2 font-mono text-lg text-amber-500/30">{stat.ascii}</div>
              <div className="font-mono text-3xl font-bold tracking-tight text-amber-400 sm:text-4xl">
                <AnimatedCounter
                  target={stat.target}
                  suffix={stat.suffix}
                  prefix={stat.prefix}
                  duration={2000 + i * 300}
                />
              </div>
              <div className="mt-2 text-sm font-medium text-neutral-200">
                {stat.label}
              </div>
              <div className="mt-1 text-xs text-neutral-500">{stat.sublabel}</div>
            </div>
          </ScrollReveal>
        ))}
      </div>

      {/* ASCII hex divider bottom */}
      <div className="absolute -bottom-px left-0 right-0 overflow-hidden text-center font-mono text-[10px] leading-none text-amber-500/10">
        {"⬡ ".repeat(80)}
      </div>
    </section>
  );
}

"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const HoneycombScene = dynamic(
  () => import("./honeycomb-scene").then((mod) => ({ default: mod.HoneycombScene })),
  { ssr: false }
);

const TERMINAL_LINES = [
  { text: "$ queen-claw init --mode hive", color: "text-neutral-500", delay: 0 },
  { text: "", color: "", delay: 400 },
  { text: "Initializing Hive with Queen node...", color: "text-amber-400", delay: 600 },
  { text: "Loading Mission Statement from SOUL.md", color: "text-neutral-400", delay: 900 },
  { text: "TUF root key verified ✓ (3-of-5 threshold)", color: "text-neutral-400", delay: 1200 },
  { text: "Beacon scheduler started (02:00 UTC ± 90m jitter)", color: "text-neutral-400", delay: 1500 },
  { text: "Human Knowledge Firewall active (v1.0, strict-allowlist)", color: "text-neutral-400", delay: 1800 },
  { text: "Registering Worker slots [0/∞]...", color: "text-neutral-400", delay: 2100 },
  { text: "", color: "", delay: 2400 },
  { text: "╔══════════════════════════════════════════╗", color: "text-amber-500/60", delay: 2500 },
  { text: "║  Queen is live. Awaiting swarm.          ║", color: "text-emerald-400", delay: 2600 },
  { text: "║  Contribution mode: ENABLED              ║", color: "text-emerald-400", delay: 2700 },
  { text: "║  Privacy invariants: ALL PASSING         ║", color: "text-emerald-400", delay: 2800 },
  { text: "╚══════════════════════════════════════════╝", color: "text-amber-500/60", delay: 2900 },
];

function TerminalLine({
  line,
  show,
}: {
  line: { text: string; color: string };
  show: boolean;
}) {
  if (!show) return null;
  if (!line.text) return <div className="h-2" />;
  return (
    <div className={`${line.color} animate-fade-in-up`}>
      {line.text}
    </div>
  );
}

export function Hero() {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    const timers = TERMINAL_LINES.map((line, i) =>
      setTimeout(() => setVisibleLines(i + 1), line.delay)
    );
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <section className="relative min-h-screen overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
      {/* Three.js background */}
      <HoneycombScene />

      {/* Extra radial glows */}
      <div className="pointer-events-none absolute top-0 left-1/2 h-[700px] w-[900px] -translate-x-1/2 rounded-full bg-amber-500/[0.07] blur-[100px]" />
      <div className="pointer-events-none absolute bottom-0 left-1/4 h-[400px] w-[600px] rounded-full bg-amber-600/[0.04] blur-[80px]" />

      <div className="relative mx-auto max-w-5xl px-6 text-center">
        {/* Badge */}
        <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-neutral-900/80 px-4 py-1.5 text-sm text-amber-400 backdrop-blur-sm">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-mono text-xs tracking-wide">
            queen-claw v0.1 // MIT Licensed
          </span>
        </div>

        {/* ASCII logo above heading */}
        <pre className="mx-auto mb-6 hidden text-[8px] leading-[1.1] text-amber-500/40 sm:block sm:text-[10px]" aria-hidden="true">
{`        ___  ___  ___  ___
       /   \\/   \\/   \\/   \\
      / \\  / \\  / \\  / \\  /
     /   \\/   \\/   \\/   \\/
    | \\  / \\  / \\  / \\  / |
    |  \\/   \\/   \\/   \\/  |
    |  /\\   /\\   /\\   /\\  |
    | /  \\ /  \\ /  \\ /  \\ |
     \\   /\\   /\\   /\\   /
      \\ /  \\ /  \\ /  \\ /
       \\___/\\___/\\___/`}
        </pre>

        <h1 className="mx-auto max-w-4xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
          <span className="text-neutral-100">Governance for</span>
          <br />
          <span className="bg-gradient-to-r from-amber-300 via-amber-500 to-amber-600 bg-clip-text text-transparent">
            Sovereign AI Agents
          </span>
        </h1>

        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-neutral-400 sm:text-xl">
          Privacy-preserving, queen-centric swarm infrastructure that solves
          version drift, security fragmentation, and supply-chain poisoning
          for autonomous AI agent deployments.
        </p>

        <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
          <a
            href="#architecture"
            className="group inline-flex h-12 items-center gap-2 rounded-lg bg-amber-500 px-8 text-sm font-semibold text-neutral-950 shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-400 hover:shadow-amber-500/40 hover:scale-[1.02]"
          >
            Explore the Architecture
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              className="transition-transform group-hover:translate-x-0.5"
            >
              <path
                d="M6 3l5 5-5 5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
          <a
            href="#roadmap"
            className="inline-flex h-12 items-center rounded-lg border border-neutral-700 bg-neutral-900/80 px-8 text-sm font-semibold text-neutral-200 backdrop-blur-sm transition-all hover:border-neutral-600 hover:bg-neutral-800"
          >
            View Roadmap
          </a>
        </div>

        {/* Terminal preview with typing effect */}
        <div className="mx-auto mt-16 max-w-2xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/90 shadow-2xl shadow-black/40 backdrop-blur-sm animate-glow-pulse">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
            <span className="h-3 w-3 rounded-full bg-red-500/60" />
            <span className="h-3 w-3 rounded-full bg-yellow-400/60" />
            <span className="h-3 w-3 rounded-full bg-emerald-400/60" />
            <span className="ml-3 font-mono text-xs text-neutral-500">
              queen-claw@hive:~
            </span>
          </div>
          <div className="scanline relative p-5 text-left font-mono text-xs leading-relaxed sm:text-sm">
            {TERMINAL_LINES.map((line, i) => (
              <TerminalLine key={i} line={line} show={i < visibleLines} />
            ))}
            {visibleLines >= TERMINAL_LINES.length && (
              <div className="mt-2 flex items-center gap-1 text-neutral-500">
                <span>$</span>
                <span className="inline-block h-4 w-2 animate-pulse bg-amber-400" />
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

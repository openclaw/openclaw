"use client";

import { ScrollReveal } from "./ascii-art";

const CTA_ASCII = `
  ╔════════════════════════════════════════════════════════╗
  ║                                                        ║
  ║   Ship the firewall first.                             ║
  ║   Test it adversarially.                               ║
  ║   Document every architectural decision.               ║
  ║   Open the first PR publicly.                          ║
  ║   Invite three builders personally.                    ║
  ║                                                        ║
  ║               — The Founding Commitment                ║
  ║                                                        ║
  ╚════════════════════════════════════════════════════════╝
`;

export function CTA() {
  return (
    <section className="relative py-24 sm:py-32">
      {/* Background glow */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="h-[500px] w-[500px] rounded-full bg-amber-500/[0.04] blur-[100px]" />
      </div>

      <div className="relative mx-auto max-w-4xl px-6 text-center">
        <ScrollReveal>
          <div className="overflow-hidden rounded-2xl border border-amber-500/20 bg-gradient-to-b from-amber-500/5 via-neutral-950 to-neutral-950 p-12 sm:p-16">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              The moat is not the code.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-neutral-400">
              The moat is the first public contribution PR &mdash; with a verified
              firewall log, a clean diff, and a community security review &mdash; that
              demonstrates the privacy-preserving collective intelligence loop
              actually works.
            </p>

            {/* ASCII commitment */}
            <pre className="mx-auto mt-8 max-w-xl font-mono text-[9px] leading-tight text-amber-500/40 sm:text-[11px]">
              {CTA_ASCII}
            </pre>

            <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex h-12 items-center gap-2 rounded-lg bg-amber-500 px-8 text-sm font-semibold text-neutral-950 shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-400 hover:shadow-amber-500/40 hover:scale-[1.02]"
              >
                <GithubIcon />
                Star queen-claw on GitHub
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
                href="#architecture"
                className="inline-flex h-12 items-center rounded-lg border border-neutral-700 bg-neutral-900 px-8 text-sm font-semibold text-neutral-200 transition-all hover:border-neutral-600 hover:bg-neutral-800"
              >
                Read the Architecture
              </a>
            </div>
            <p className="mt-8 font-mono text-xs text-neutral-600">
              MIT Licensed // queen-claw // Privacy-first by design
            </p>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}

function GithubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

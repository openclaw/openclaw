export function Hero() {
  return (
    <section className="relative overflow-hidden pt-32 pb-20 sm:pt-40 sm:pb-28">
      {/* Background grid effect */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(245,158,11,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(245,158,11,0.03)_1px,transparent_1px)] bg-[size:64px_64px]" />
      {/* Radial glow */}
      <div className="pointer-events-none absolute top-0 left-1/2 h-[600px] w-[800px] -translate-x-1/2 rounded-full bg-amber-500/5 blur-3xl" />

      <div className="relative mx-auto max-w-5xl px-6 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/5 px-4 py-1.5 text-sm text-amber-400">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
          Built on queen-claw &middot; MIT Licensed
        </div>

        <h1 className="mx-auto max-w-4xl text-4xl font-bold leading-tight tracking-tight sm:text-6xl lg:text-7xl">
          <span className="text-neutral-100">Governance for</span>{" "}
          <span className="bg-gradient-to-r from-amber-400 to-amber-600 bg-clip-text text-transparent">
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
            className="inline-flex h-12 items-center rounded-lg bg-amber-500 px-8 text-sm font-semibold text-neutral-950 shadow-lg shadow-amber-500/20 transition-all hover:bg-amber-400 hover:shadow-amber-500/30"
          >
            Explore the Architecture
          </a>
          <a
            href="#roadmap"
            className="inline-flex h-12 items-center rounded-lg border border-neutral-700 bg-neutral-900 px-8 text-sm font-semibold text-neutral-200 transition-all hover:border-neutral-600 hover:bg-neutral-800"
          >
            View Roadmap
          </a>
        </div>

        {/* Terminal preview */}
        <div className="mx-auto mt-16 max-w-2xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 shadow-2xl">
          <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-3">
            <span className="h-3 w-3 rounded-full bg-neutral-700" />
            <span className="h-3 w-3 rounded-full bg-neutral-700" />
            <span className="h-3 w-3 rounded-full bg-neutral-700" />
            <span className="ml-2 text-xs text-neutral-500">queen-claw</span>
          </div>
          <div className="p-5 text-left font-mono text-sm leading-relaxed">
            <div className="text-neutral-500">
              $ queen-claw init --mode hive
            </div>
            <div className="mt-2 text-amber-400">
              Initializing Hive with Queen node...
            </div>
            <div className="text-neutral-400">
              Loading Mission Statement from SOUL.md
            </div>
            <div className="text-neutral-400">
              TUF root key verified (3-of-5 threshold)
            </div>
            <div className="text-neutral-400">
              Beacon scheduler started (02:00 UTC +/- 90m jitter)
            </div>
            <div className="text-neutral-400">
              Human Knowledge Firewall active (v1.0, schema: strict-allowlist)
            </div>
            <div className="mt-2 text-emerald-400">
              Queen is live. 0 Workers connected. Awaiting swarm.
            </div>
            <div className="mt-2 inline-block h-4 w-2 animate-pulse bg-amber-400" />
          </div>
        </div>
      </div>
    </section>
  );
}

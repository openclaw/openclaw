const problems = [
  {
    icon: <ChainIcon />,
    title: "Supply-Chain Poisoning",
    description:
      "ClawHub's unvetted skill marketplace enabled data exfiltration and prompt injection without user awareness. Any agent-compatible registry faces this threat.",
  },
  {
    icon: <DriftIcon />,
    title: "Version Drift",
    description:
      "93.4% of exposed instances had authentication bypass conditions due to version drift. No mechanism existed for security-critical signed updates.",
  },
  {
    icon: <ShieldOffIcon />,
    title: "No Governance Layer",
    description:
      "Once prompt injection succeeds, broad agent permissions (email, calendar, shell) become a single attack surface with no capability scope enforcement.",
  },
];

export function Problem() {
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-amber-500 uppercase">
            The Governance Gap
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            OpenClaw proved demand.{" "}
            <span className="text-neutral-400">It also proved the cost of shipping without governance.</span>
          </h2>
        </div>
        <div className="mx-auto mt-16 grid max-w-5xl gap-8 md:grid-cols-3">
          {problems.map((problem) => (
            <div
              key={problem.title}
              className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-6 transition-all hover:border-amber-500/30 hover:bg-neutral-900"
            >
              <div className="mb-4 inline-flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/10 text-red-400">
                {problem.icon}
              </div>
              <h3 className="text-lg font-semibold text-neutral-100">
                {problem.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                {problem.description}
              </p>
            </div>
          ))}
        </div>
        <div className="mx-auto mt-12 max-w-3xl rounded-xl border border-amber-500/20 bg-amber-500/5 p-6 text-center">
          <p className="text-sm leading-relaxed text-amber-200/80">
            <span className="font-semibold text-amber-400">The Hive&apos;s Position:</span>{" "}
            We are not competing with OpenClaw. We are building the governance
            infrastructure that OpenClaw&apos;s foundation will eventually need to
            implement.
          </p>
        </div>
      </div>
    </section>
  );
}

function ChainIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      <line x1="2" y1="2" x2="22" y2="22" stroke="currentColor" strokeWidth="1.5" opacity="0.5" />
    </svg>
  );
}

function DriftIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}

function ShieldOffIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 2.76 1.56 5.63 4.05 7.78" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

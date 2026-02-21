const analogies = [
  {
    bee: "Queen pheromone signaling",
    problem: "Colony coherence under distributed execution",
    hive: "Queen broadcast: Mission Statement + signed nightly packs",
  },
  {
    bee: "Foraging waggle dance",
    problem: "Resource routing without central planning",
    hive: "Worker skill routing: Beacon scheduler + task dispatch",
  },
  {
    bee: "Trophallaxis (food sharing)",
    problem: "Information transfer with contamination control",
    hive: "Sanitized telemetry: firewall-gated skill metrics only",
  },
  {
    bee: "Social immunity",
    problem: "Colony-level pathogen defense",
    hive: "TUF-signed skill packs + CVE evaluation gates",
  },
  {
    bee: "Swarming (colony fission)",
    problem: "Scaling without fragmenting core genetics",
    hive: "Sub-Queen federation with shared Queen lineage",
  },
];

export function Biology() {
  return (
    <section className="border-y border-neutral-800/50 bg-neutral-900/30 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-amber-500 uppercase">
            Biological Foundations
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            30 Million Years of{" "}
            <span className="text-amber-400">Resilience Engineering</span>
          </h2>
          <p className="mt-4 text-neutral-400">
            Not metaphors &mdash; design constraints. Bee colony biology solved the exact
            problems facing distributed AI agent deployments.
          </p>
        </div>

        <div className="mx-auto mt-16 max-w-4xl overflow-hidden rounded-xl border border-neutral-800">
          {/* Table header */}
          <div className="grid grid-cols-3 border-b border-neutral-800 bg-neutral-900/80">
            <div className="p-4 text-xs font-semibold tracking-wider text-amber-400 uppercase">
              Bee Colony
            </div>
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              Problem Solved
            </div>
            <div className="p-4 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
              Hive Implementation
            </div>
          </div>
          {/* Table rows */}
          {analogies.map((row, i) => (
            <div
              key={i}
              className="grid grid-cols-3 border-b border-neutral-800/50 last:border-0 transition-colors hover:bg-neutral-800/30"
            >
              <div className="p-4 text-sm font-medium text-neutral-200">
                {row.bee}
              </div>
              <div className="p-4 text-sm text-neutral-400">{row.problem}</div>
              <div className="p-4 text-sm text-neutral-300">{row.hive}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const layers = [
  {
    name: "Identity Layer",
    color: "amber",
    components: "Queen, Mission Statement, SOUL.md, Conway Wallet",
    description: "Who the user is. What the Hive is allowed to do. Financial sovereignty boundary.",
  },
  {
    name: "Orchestration Layer",
    color: "amber",
    components: "Beacon Scheduler, Command Processor, Sub-Queen Router",
    description: "When things happen. What Workers are assigned. How commands flow down the hierarchy.",
  },
  {
    name: "Execution Layer",
    color: "amber",
    components: "Worker Agents, Skills, Sandbox Containers",
    description: "What actually runs. Tool invocation. Real-world actions. Result reporting.",
  },
  {
    name: "Intelligence Layer",
    color: "amber",
    components: "Telemetry Aggregator, Firewall, Contributor Skill, TUF Packs",
    description: "How the colony learns. What gets shared. What gets blocked.",
  },
];

const queenCapabilities = [
  "Mission Statement enforcer (SOUL.md)",
  "Conway financial veto (sole wallet access)",
  "TUF trust root (signed pack distribution)",
  "Contributor skill authority (sole PR opener)",
  "Sub-Queen delegation for federation",
  "SSH-like session control for all Workers",
];

export function Architecture() {
  return (
    <section id="architecture" className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-semibold tracking-widest text-amber-500 uppercase">
            System Design
          </p>
          <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            Queen-Centric Architecture
          </h2>
          <p className="mt-4 text-neutral-400">
            One Queen per Hive. Not a &ldquo;more powerful worker&rdquo; &mdash; a structurally
            distinct role with exclusive governance capabilities.
          </p>
        </div>

        {/* Layer stack */}
        <div className="mx-auto mt-16 max-w-3xl space-y-3">
          {layers.map((layer, i) => (
            <div
              key={layer.name}
              className="group relative overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 transition-all hover:border-amber-500/30"
              style={{ opacity: 1 - i * 0.05 }}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
                <span className="shrink-0 text-sm font-bold text-amber-400">
                  {layer.name}
                </span>
                <span className="hidden text-neutral-700 sm:inline">/</span>
                <span className="text-xs text-neutral-500">
                  {layer.components}
                </span>
              </div>
              <p className="mt-2 text-sm text-neutral-400">
                {layer.description}
              </p>
            </div>
          ))}
        </div>

        {/* Queen capabilities */}
        <div className="mx-auto mt-20 grid max-w-5xl gap-12 lg:grid-cols-2">
          <div>
            <h3 className="text-xl font-bold">Queen-Exclusive Capabilities</h3>
            <p className="mt-2 text-sm text-neutral-400">
              The Queen holds governance responsibilities that Workers explicitly do not have.
              There is exactly one Queen per Hive.
            </p>
            <ul className="mt-6 space-y-3">
              {queenCapabilities.map((cap) => (
                <li key={cap} className="flex items-start gap-3">
                  <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                  <span className="text-sm text-neutral-300">{cap}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
            <h3 className="text-lg font-bold">Contribution Loop</h3>
            <p className="mt-2 text-sm text-neutral-400">
              End-to-end flow from Worker telemetry to ecosystem improvement.
            </p>
            <ol className="mt-6 space-y-4">
              {[
                "Workers aggregate 24h skill metrics locally",
                "Queen receives metrics, runs Human Knowledge Firewall",
                "Firewall-clean data enters proposal generator",
                "Queen generates diff (skills & SOUL.md lens only)",
                "Queen opens draft PR to queen-claw",
                "Human maintainer reviews & merges",
                "TUF signing workflow creates signed release",
                "All Queens pull new pack via nightly Beacon",
              ].map((step, i) => (
                <li key={i} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-xs font-bold text-amber-400">
                    {i + 1}
                  </span>
                  <span className="text-sm text-neutral-300">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

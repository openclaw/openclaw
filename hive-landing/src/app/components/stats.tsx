const stats = [
  {
    value: "175K+",
    label: "OpenClaw GitHub Stars",
    sublabel: "Fastest-growing OSS repo in history",
  },
  {
    value: "$52.6B",
    label: "Agent Market by 2030",
    sublabel: "46.3% CAGR from $5.25B",
  },
  {
    value: "9+",
    label: "Critical CVEs in 90 Days",
    sublabel: "Documented OpenClaw vulnerabilities",
  },
  {
    value: "42,665+",
    label: "Exposed Instances",
    sublabel: "93% with auth bypass",
  },
];

export function Stats() {
  return (
    <section className="border-y border-neutral-800/50 bg-neutral-900/50 py-16">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-6 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className="text-center">
            <div className="text-3xl font-bold tracking-tight text-amber-400 sm:text-4xl">
              {stat.value}
            </div>
            <div className="mt-2 text-sm font-medium text-neutral-200">
              {stat.label}
            </div>
            <div className="mt-1 text-xs text-neutral-500">{stat.sublabel}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

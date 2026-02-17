const providerColors: Record<string, string> = {
  slack: "bg-purple-900/50 text-purple-300 border-purple-700",
  discord: "bg-indigo-900/50 text-indigo-300 border-indigo-700",
  telegram: "bg-sky-900/50 text-sky-300 border-sky-700",
};

export default function ConnectionBadge({
  provider,
  name,
}: {
  provider: string;
  name: string | null;
}) {
  const colors = providerColors[provider] ?? "bg-gray-800 text-gray-300 border-gray-700";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium ${colors}`}
    >
      <span className="capitalize">{provider}</span>
      {name && <span className="text-gray-400">· {name}</span>}
    </span>
  );
}

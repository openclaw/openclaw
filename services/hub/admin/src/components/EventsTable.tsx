import type { EventLogEntry } from "../api";

const statusColors: Record<string, string> = {
  delivered: "bg-green-900/50 text-green-400",
  failed: "bg-red-900/50 text-red-400",
  no_route: "bg-yellow-900/50 text-yellow-400",
  challenge: "bg-blue-900/50 text-blue-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`px-2 py-0.5 rounded text-xs font-medium ${statusColors[status] ?? "bg-gray-800 text-gray-400"}`}
    >
      {status}
    </span>
  );
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) {
    return `${s}s ago`;
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return new Date(ts).toLocaleDateString();
}

export default function EventsTable({ events }: { events: EventLogEntry[] }) {
  if (events.length === 0) {
    return <p className="text-gray-500 text-sm">No events yet.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-800">
            <th className="pb-2 pr-4">Time</th>
            <th className="pb-2 pr-4">Provider</th>
            <th className="pb-2 pr-4">External ID</th>
            <th className="pb-2 pr-4">Event</th>
            <th className="pb-2 pr-4">Status</th>
            <th className="pb-2 pr-4">HTTP</th>
            <th className="pb-2">Latency</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-gray-800/50 hover:bg-gray-900/50">
              <td className="py-2 pr-4 text-gray-400">{timeAgo(e.createdAt)}</td>
              <td className="py-2 pr-4">{e.provider}</td>
              <td className="py-2 pr-4 font-mono text-xs text-gray-400">{e.externalId ?? "-"}</td>
              <td className="py-2 pr-4">{e.eventType}</td>
              <td className="py-2 pr-4">
                <StatusBadge status={e.status} />
              </td>
              <td className="py-2 pr-4 text-gray-400">{e.responseStatus ?? "-"}</td>
              <td className="py-2 text-gray-400">
                {e.latencyMs != null ? `${e.latencyMs}ms` : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

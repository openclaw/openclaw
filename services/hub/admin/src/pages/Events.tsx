import { useState, useEffect } from "react";
import { listEvents, listInstances, type EventLogEntry, type InstanceSummary } from "../api";
import EventsTable from "../components/EventsTable";

const PAGE_SIZE = 50;

export default function Events() {
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [instanceId, setInstanceId] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");

  const refresh = async (newOffset = 0) => {
    setLoading(true);
    try {
      const result = await listEvents({
        instance_id: instanceId || undefined,
        provider: provider || undefined,
        status: status || undefined,
        limit: PAGE_SIZE,
        offset: newOffset,
      });
      setEvents(result.events);
      setTotal(result.total);
      setOffset(newOffset);
    } catch {
      /* handled by api.ts */
    }
    setLoading(false);
  };

  useEffect(() => {
    listInstances()
      .then(setInstances)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void refresh(0);
  }, [instanceId, provider, status]);

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div>
      <h2 className="text-xl font-semibold mb-6">Events</h2>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-4">
        <select
          value={instanceId}
          onChange={(e) => setInstanceId(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white"
        >
          <option value="">All instances</option>
          {instances.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white"
        >
          <option value="">All providers</option>
          <option value="slack">Slack</option>
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="px-3 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white"
        >
          <option value="">All statuses</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Failed</option>
          <option value="no_route">No Route</option>
          <option value="challenge">Challenge</option>
        </select>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : (
        <>
          <EventsTable events={events} />

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-gray-400">
              <span>{total} total events</span>
              <div className="flex gap-2">
                <button
                  onClick={() => refresh(offset - PAGE_SIZE)}
                  disabled={offset === 0}
                  className="px-3 py-1 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-50"
                >
                  Prev
                </button>
                <span className="px-3 py-1">
                  {currentPage} / {totalPages}
                </span>
                <button
                  onClick={() => refresh(offset + PAGE_SIZE)}
                  disabled={currentPage >= totalPages}
                  className="px-3 py-1 bg-gray-800 rounded hover:bg-gray-700 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

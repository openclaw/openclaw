import { useState, useEffect, useRef } from "react";
import {
  getInstance,
  startInstance,
  stopInstance,
  listEvents,
  getInstanceLogs,
  getInstanceStatus,
  type InstanceDetail as InstanceDetailType,
  type EventLogEntry,
} from "../api";
import ConnectionBadge from "../components/ConnectionBadge";
import EventsTable from "../components/EventsTable";

const statusColors: Record<string, string> = {
  running: "bg-green-900/50 text-green-400",
  exited: "bg-red-900/50 text-red-400",
  paused: "bg-yellow-900/50 text-yellow-400",
  manual: "bg-gray-800 text-gray-400",
};

export default function InstanceDetail({ id }: { id: string }) {
  const [instance, setInstance] = useState<InstanceDetailType | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [logs, setLogs] = useState<string>("");
  const [containerStatus, setContainerStatus] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [logsAutoRefresh, setLogsAutoRefresh] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const [inst, evts] = await Promise.all([
        getInstance(id),
        listEvents({ instance_id: id, limit: 20 }),
      ]);
      setInstance(inst);
      setEvents(evts.events);
    } catch {
      /* handled by api.ts */
    }
    setLoading(false);
  };

  const refreshLogs = async () => {
    if (!instance?.containerId) {
      return;
    }
    try {
      const [logsRes, statusRes] = await Promise.all([
        getInstanceLogs(id, 200),
        getInstanceStatus(id),
      ]);
      setLogs(logsRes.logs);
      setContainerStatus(statusRes.status);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    void refresh();
  }, [id]);

  // Fetch logs once instance is loaded
  useEffect(() => {
    if (instance?.containerId) {
      void refreshLogs();
    }
  }, [instance?.containerId]);

  // Auto-refresh logs every 3s
  useEffect(() => {
    if (!instance?.containerId || !logsAutoRefresh) {
      return;
    }
    const interval = setInterval(refreshLogs, 3000);
    return () => clearInterval(interval);
  }, [instance?.containerId, logsAutoRefresh]);

  // Scroll logs to bottom on update
  useEffect(() => {
    if (logsAutoRefresh) {
      logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, logsAutoRefresh]);

  const handleStart = async () => {
    setActionLoading(true);
    try {
      await startInstance(id);
      setTimeout(refreshLogs, 1000);
    } catch {
      /* ignore */
    }
    setActionLoading(false);
  };

  const handleStop = async () => {
    setActionLoading(true);
    try {
      await stopInstance(id);
      setTimeout(refreshLogs, 1000);
    } catch {
      /* ignore */
    }
    setActionLoading(false);
  };

  if (loading) {
    return <p className="text-gray-500">Loading...</p>;
  }

  if (!instance) {
    return <p className="text-red-400">Instance not found.</p>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <a href="#/instances" className="text-gray-500 hover:text-white text-sm">
          &larr; Back
        </a>
        <h2 className="text-xl font-semibold">{instance.name}</h2>
        {instance.containerId && (
          <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400">Docker</span>
        )}
        {containerStatus && (
          <span
            className={`px-2 py-0.5 rounded text-xs ${statusColors[containerStatus] ?? "bg-gray-800 text-gray-400"}`}
          >
            {containerStatus}
          </span>
        )}
      </div>

      {/* Info */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2 text-sm">
        <div className="flex gap-2">
          <span className="text-gray-500 w-28">ID</span>
          <span className="font-mono text-xs text-gray-300">{instance.id}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-500 w-28">Gateway URL</span>
          <span className="text-gray-300">{instance.gatewayUrl}</span>
        </div>
        <div className="flex gap-2">
          <span className="text-gray-500 w-28">Bridge URL</span>
          <span className="text-gray-300">{instance.bridgeUrl}</span>
        </div>
        {instance.containerId && (
          <div className="flex gap-2">
            <span className="text-gray-500 w-28">Container</span>
            <span className="font-mono text-xs text-gray-300">
              {instance.containerId.slice(0, 12)}
            </span>
          </div>
        )}
      </div>

      {/* Docker controls */}
      {instance.containerId && (
        <div className="flex gap-2">
          <button
            onClick={handleStart}
            disabled={actionLoading}
            className="px-3 py-1.5 text-sm bg-green-700 hover:bg-green-600 text-white rounded disabled:opacity-50"
          >
            Start
          </button>
          <button
            onClick={handleStop}
            disabled={actionLoading}
            className="px-3 py-1.5 text-sm bg-red-700 hover:bg-red-600 text-white rounded disabled:opacity-50"
          >
            Stop
          </button>
        </div>
      )}

      {/* Container Logs */}
      {instance.containerId && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-medium">Container Logs</h3>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-400">
                <input
                  type="checkbox"
                  checked={logsAutoRefresh}
                  onChange={(e) => setLogsAutoRefresh(e.target.checked)}
                  className="rounded bg-gray-800 border-gray-700"
                />
                Auto-refresh
              </label>
              <button
                onClick={refreshLogs}
                className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded"
              >
                Refresh
              </button>
            </div>
          </div>
          <div className="bg-black border border-gray-800 rounded-lg p-4 max-h-96 overflow-y-auto font-mono text-xs leading-5 text-gray-300 whitespace-pre-wrap">
            {logs || <span className="text-gray-600">No logs available.</span>}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}

      {/* Connections */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-medium">Connections</h3>
          <a
            href={`/slack/install?instance_id=${instance.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 text-sm bg-purple-700 hover:bg-purple-600 text-white rounded"
          >
            Connect Slack
          </a>
        </div>
        {instance.connections.length === 0 ? (
          <p className="text-gray-500 text-sm">No connections yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {instance.connections.map((conn) => (
              <ConnectionBadge key={conn.id} provider={conn.provider} name={conn.externalName} />
            ))}
          </div>
        )}
      </div>

      {/* Recent Events */}
      <div>
        <h3 className="text-lg font-medium mb-3">Recent Events</h3>
        <EventsTable events={events} />
      </div>
    </div>
  );
}

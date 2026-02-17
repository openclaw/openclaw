import { useState, useEffect } from "react";
import { listInstances, deleteInstance, type InstanceSummary } from "../api";
import CreateInstanceModal from "../components/CreateInstanceModal";

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

export default function Instances() {
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      setInstances(await listInstances());
    } catch {
      /* handled by api.ts */
    }
    setLoading(false);
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this instance and all its connections?")) {
      return;
    }
    try {
      await deleteInstance(id);
      void refresh();
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-semibold">Instances</h2>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
        >
          Create Instance
        </button>
      </div>

      {loading ? (
        <p className="text-gray-500">Loading...</p>
      ) : instances.length === 0 ? (
        <p className="text-gray-500">No instances yet. Create one to get started.</p>
      ) : (
        <div className="space-y-2">
          {instances.map((inst) => (
            <div
              key={inst.id}
              className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg p-4 hover:border-gray-700"
            >
              <a href={`#/instances/${inst.id}`} className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-medium text-white">{inst.name}</span>
                  {inst.containerId && (
                    <span className="px-2 py-0.5 rounded text-xs bg-cyan-900/50 text-cyan-400">
                      Docker
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Created {timeAgo(inst.createdAt)} · {inst.bridgeUrl}
                </div>
              </a>
              <div className="flex items-center gap-2 ml-4">
                <a
                  href={`${inst.gatewayUrl.replace(/^ws/, "http")}?token=${inst.gatewayToken}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 text-white rounded"
                >
                  Dashboard
                </a>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    void handleDelete(inst.id);
                  }}
                  className="text-xs text-gray-500 hover:text-red-400"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate && (
        <CreateInstanceModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

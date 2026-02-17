import { useState } from "react";
import { createInstance } from "../api";

export default function CreateInstanceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [spawn, setSpawn] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [gatewayToken, setGatewayToken] = useState("");
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      let result;
      if (spawn) {
        result = await createInstance({ name, spawn: true });
      } else {
        result = await createInstance({ name, gatewayUrl, gatewayToken, bridgeUrl });
      }
      if (result.dashboardUrl) {
        setDashboardUrl(result.dashboardUrl);
      } else {
        onCreated();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async () => {
    if (!dashboardUrl) {
      return;
    }
    await navigator.clipboard.writeText(dashboardUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDone = () => {
    onCreated();
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-full max-w-md">
        {dashboardUrl ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Instance Created</h2>
            <p className="text-sm text-gray-400">
              Your OpenClaw instance is running. Use this URL to access the dashboard:
            </p>
            <div className="bg-gray-800 border border-gray-700 rounded p-3">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={dashboardUrl}
                  className="flex-1 bg-transparent text-sm font-mono text-green-400 outline-none truncate"
                />
                <button
                  onClick={handleCopy}
                  className="shrink-0 px-2 py-1 text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 rounded"
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            </div>
            <p className="text-xs text-yellow-500/80">
              This URL contains the access token. Save it now — it won't be shown again.
            </p>
            <div className="flex justify-between">
              <a
                href={dashboardUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-4 py-2 text-sm bg-green-700 hover:bg-green-600 text-white rounded"
              >
                Open Dashboard
              </a>
              <button
                onClick={handleDone}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <h2 className="text-lg font-semibold mb-4">Create Instance</h2>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-400 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="spawn"
                  checked={spawn}
                  onChange={(e) => setSpawn(e.target.checked)}
                  className="rounded bg-gray-800 border-gray-700"
                />
                <label htmlFor="spawn" className="text-sm text-gray-400">
                  Spawn Docker container
                </label>
              </div>

              {!spawn && (
                <>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Gateway URL</label>
                    <input
                      type="text"
                      value={gatewayUrl}
                      onChange={(e) => setGatewayUrl(e.target.value)}
                      required={!spawn}
                      placeholder="ws://localhost:18789"
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Gateway Token</label>
                    <input
                      type="password"
                      value={gatewayToken}
                      onChange={(e) => setGatewayToken(e.target.value)}
                      required={!spawn}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-400 mb-1">Bridge URL</label>
                    <input
                      type="text"
                      value={bridgeUrl}
                      onChange={(e) => setBridgeUrl(e.target.value)}
                      required={!spawn}
                      placeholder="http://localhost:18790"
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white focus:outline-none focus:border-blue-500"
                    />
                  </div>
                </>
              )}

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

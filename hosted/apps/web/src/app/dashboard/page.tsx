"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

interface Instance {
  id: string;
  status: "pending" | "provisioning" | "running" | "stopped" | "error";
  public_url: string | null;
}

interface DeploymentStatus {
  phase: string;
  logs: string[];
}

export default function DashboardPage() {
  const [instance, setInstance] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const [chatHistory, setChatHistory] = useState<
    { role: "user" | "assistant"; content: string }[]
  >([]);
  const [sending, setSending] = useState(false);
  const [deployStatus, setDeployStatus] = useState<DeploymentStatus | null>(null);

  // Fetch instance on load
  useEffect(() => {
    fetchInstance();
  }, []);

  // Poll for status updates when provisioning
  useEffect(() => {
    if (instance?.status === "provisioning") {
      const interval = setInterval(() => {
        fetchInstance();
        fetchDeployStatus();
      }, 3000);
      fetchDeployStatus(); // Initial fetch
      return () => clearInterval(interval);
    } else {
      setDeployStatus(null);
    }
  }, [instance?.status, instance?.id]);

  async function fetchDeployStatus() {
    if (!instance?.id) return;
    try {
      const response = await fetch(`/api/instances/${instance.id}/deploy-status`);
      if (response.ok) {
        const data = await response.json();
        setDeployStatus(data);
        // Update instance status if deployment completed
        if (data.phase === "ACTIVE") {
          fetchInstance();
        }
      }
    } catch (error) {
      console.error("Error fetching deploy status:", error);
    }
  }

  async function fetchInstance() {
    try {
      const response = await fetch("/api/instances");
      const data = await response.json();
      if (data.instances && data.instances.length > 0) {
        setInstance(data.instances[0]);
      }
    } catch (error) {
      console.error("Error fetching instance:", error);
    } finally {
      setLoading(false);
    }
  }

  async function createInstance() {
    setCreating(true);
    try {
      const response = await fetch("/api/instances", { method: "POST" });
      const data = await response.json();
      if (data.id) {
        setInstance({ id: data.id, status: "provisioning", public_url: null });
      } else if (data.error) {
        alert("Error: " + data.error);
      }
    } catch (error) {
      console.error("Error creating instance:", error);
    } finally {
      setCreating(false);
    }
  }

  async function deleteInstance() {
    if (!instance) return;
    if (!confirm("Delete this instance and try again?")) return;

    try {
      const response = await fetch(`/api/instances/${instance.id}`, { method: "DELETE" });
      if (response.ok) {
        setInstance(null);
      }
    } catch (error) {
      console.error("Error deleting instance:", error);
    }
  }

  async function openControlUI() {
    if (!instance) return;
    try {
      const response = await fetch(`/api/instances/${instance.id}/control-url`);
      const data = await response.json();
      if (data.url) {
        window.open(data.url, "_blank");
      } else {
        alert("Could not get Control UI URL: " + (data.error || "Unknown error"));
      }
    } catch (error) {
      console.error("Error getting control URL:", error);
      alert("Error opening Control UI");
    }
  }

  async function sendMessage() {
    if (!message.trim() || !instance?.id || instance.status !== "running" || sending) return;

    const userMessage = message.trim();
    setMessage("");
    setSending(true);
    setChatHistory((prev) => [...prev, { role: "user", content: userMessage }]);

    try {
      // Send message through our proxy API (avoids CORS issues)
      const response = await fetch(`/api/instances/${instance.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userMessage }),
      });

      const data = await response.json();
      if (data.error) {
        setChatHistory((prev) => [
          ...prev,
          { role: "assistant", content: `Error: ${data.error}` },
        ]);
      } else {
        setChatHistory((prev) => [
          ...prev,
          { role: "assistant", content: data.response || "No response" },
        ]);
      }
    } catch (error) {
      console.error("Error sending message:", error);
      setChatHistory((prev) => [
        ...prev,
        { role: "assistant", content: "Error: Could not reach the bot" },
      ]);
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-white"></div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Dashboard</h1>

      {/* Instance Status */}
      <div className="mb-8 p-6 rounded-lg border border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Your Bot Instance</h2>
          {instance && <StatusBadge status={instance.status} />}
        </div>

        {!instance ? (
          <div className="text-center py-8">
            <p className="text-gray-600 dark:text-gray-400 mb-4">
              You don't have a bot instance yet.
            </p>
            <button
              onClick={createInstance}
              disabled={creating}
              className="rounded-lg bg-blue-600 text-white px-6 py-2 text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {creating ? "Creating..." : "Create Bot Instance"}
            </button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Status</span>
              <span>{instance.status}</span>
            </div>
            {instance.public_url && (
              <div className="flex justify-between items-center">
                <span className="text-gray-500">URL</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{instance.public_url}</span>
                  {instance.status === "running" && (
                    <button
                      onClick={openControlUI}
                      className="text-xs px-2 py-1 rounded bg-purple-600 text-white hover:bg-purple-700"
                    >
                      Open Control UI
                    </button>
                  )}
                </div>
              </div>
            )}
            {instance.status === "provisioning" && (
              <div className="mt-4">
                <p className="text-yellow-600 dark:text-yellow-400 text-sm mb-2">
                  Deploying your bot... This takes 2-3 minutes.
                </p>

                {/* Deployment Terminal Logs */}
                {deployStatus && (
                  <div className="mt-3 bg-gray-900 rounded-lg overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-2 bg-gray-800 border-b border-gray-700">
                      <div className="flex gap-1.5">
                        <span className="w-3 h-3 rounded-full bg-red-500" />
                        <span className="w-3 h-3 rounded-full bg-yellow-500" />
                        <span className="w-3 h-3 rounded-full bg-green-500" />
                      </div>
                      <span className="text-gray-400 text-xs font-mono ml-2">deployment logs</span>
                    </div>
                    <div className="p-3 font-mono text-xs text-green-400 max-h-64 overflow-y-auto">
                      {deployStatus.logs.map((line, i) => (
                        <div key={i} className={`${
                          line.startsWith("ERROR") || line.includes("✗") ? "text-red-400" :
                          line.includes("✓") ? "text-green-400" :
                          line.startsWith("[") ? "text-gray-300" :
                          line.startsWith("$") || line.startsWith("===") ? "text-blue-400" :
                          line.startsWith("Phase:") ? "text-yellow-400" :
                          "text-gray-400"
                        }`}>
                          {line || "\u00A0"}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  onClick={deleteInstance}
                  className="mt-3 rounded-lg bg-gray-600 text-white px-4 py-2 text-sm font-semibold hover:bg-gray-700 transition-colors"
                >
                  Cancel & Delete
                </button>
              </div>
            )}
            {instance.status === "error" && (
              <div className="mt-4">
                <p className="text-red-600 dark:text-red-400 text-sm mb-2">
                  Instance failed to create. You can delete and try again.
                </p>
                <button
                  onClick={deleteInstance}
                  className="rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-semibold hover:bg-red-700 transition-colors"
                >
                  Delete & Retry
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Chat Interface - Only show when running */}
      {instance?.status === "running" && (
        <div className="p-6 rounded-lg border border-gray-200 dark:border-gray-800">
          <h2 className="text-lg font-semibold mb-4">Chat with your Bot</h2>

          {/* Chat Messages */}
          <div className="h-80 overflow-y-auto mb-4 p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
            {chatHistory.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                Send a message to start chatting
              </p>
            ) : (
              <div className="space-y-4">
                {chatHistory.map((msg, i) => (
                  <div
                    key={i}
                    className={`flex ${
                      msg.role === "user" ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`max-w-[80%] rounded-lg px-4 py-2 ${
                        msg.role === "user"
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200 dark:bg-gray-700"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Message Input */}
          <div className="flex gap-2">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              placeholder="Type a message..."
              className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={sending}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !message.trim()}
              className="px-6 py-2 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {sending ? "..." : "Send"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
    provisioning:
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    running: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    stopped: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
    error: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
        styles[status] || styles.pending
      }`}
    >
      {status === "running" && (
        <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
      )}
      {status === "provisioning" && (
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
      )}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

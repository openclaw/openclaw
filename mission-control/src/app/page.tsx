"use client";

import { useState, useEffect } from "react";

type JobStatus = "pending" | "running" | "review" | "revising" | "done" | "failed" | "success";

type Job = {
  id: string;
  title: string;
  description: string | null;
  status: JobStatus;
  priority: number;
  created_at: number;
  result_summary: string | null;
  agent_id: string | null;
  session_key: string | null;
  pr_number: number | null;
  pr_url: string | null;
  revision_count: number;
};

type AgentStatus = {
  state: string;
  lastActivity: number;
  messageCount: number;
  isActive: boolean;
};

const COLUMNS = [
  { id: "pending", label: "Pending", color: "var(--status-pending)" },
  { id: "running", label: "In Progress", color: "var(--status-running)" },
  { id: "review", label: "Review", color: "var(--status-review)" },
  { id: "revising", label: "Revising", color: "var(--status-revising)" },
  { id: "done", label: "Done", color: "var(--status-done)" },
  { id: "failed", label: "Failed", color: "var(--status-failed)" },
] as const;

export default function MissionControl() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDesc, setNewTaskDesc] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Job | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    loadJobs();
    const interval = setInterval(loadJobs, 5000);
    return () => clearInterval(interval);
  }, []);

  async function loadJobs() {
    try {
      const res = await fetch("/api/tasks");
      const data = await res.json();
      if (data.ok) {
        setJobs(data.jobs);
      }
    } catch (err) {
      console.error("Failed to load jobs:", err);
    } finally {
      setLoading(false);
    }
  }

  async function createTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTaskTitle.trim()) {
      return;
    }

    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTaskTitle,
          description: newTaskDesc,
          type: "task",
          priority: 3,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setNewTaskTitle("");
        setNewTaskDesc("");
        loadJobs();
      }
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  }

  function getJobsByStatus(status: string) {
    // Map "success" to "done" for backward compatibility
    if (status === "done") {
      return jobs.filter((j) => j.status === "done" || j.status === "success");
    }
    return jobs.filter((j) => j.status === status);
  }

  function formatDate(ts: number) {
    return new Date(ts).toLocaleString();
  }

  async function assignAgent(jobId: string) {
    setAssigning(jobId);
    try {
      const res = await fetch(`/api/tasks/${jobId}/assign`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setLogs((prev) => [...prev, `Agent assigned to job ${jobId.slice(0, 8)}`]);
        loadJobs();
      } else {
        setLogs((prev) => [...prev, `Failed to assign agent: ${data.error}`]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, `Error: ${String(err)}`]);
    } finally {
      setAssigning(null);
    }
  }

  async function checkAgentStatus(job: Job) {
    if (!job.session_key) {
      return;
    }
    try {
      const res = await fetch(`/api/tasks/${job.id}/status`);
      const data = await res.json();
      if (data.ok) {
        setSelectedJob(job);
        setAgentStatus(data.agentStatus);
      }
    } catch (err) {
      console.error("Failed to check status:", err);
    }
  }

  async function deleteTask(jobId: string) {
    setDeleting(jobId);
    try {
      const res = await fetch(`/api/tasks/${jobId}`, { method: "DELETE" });
      const data = await res.json();
      if (data.ok) {
        setLogs((prev) => [...prev, `✓ Deleted task ${jobId.slice(0, 8)}`]);
        loadJobs();
      } else {
        setLogs((prev) => [...prev, `✗ Failed to delete: ${data.error}`]);
      }
    } catch (err) {
      setLogs((prev) => [...prev, `✗ Error deleting: ${String(err)}`]);
    } finally {
      setDeleting(null);
      setConfirmDelete(null);
    }
  }

  return (
    <div className="mc-container">
      <header className="mc-header">
        <h1 className="mc-title">
          <span className="gradient-text">Mission Control</span>
        </h1>
      </header>

      <form onSubmit={createTask} className="mc-form">
        <input
          type="text"
          placeholder="Task title..."
          value={newTaskTitle}
          onChange={(e) => setNewTaskTitle(e.target.value)}
          className="mc-input"
        />
        <input
          type="text"
          placeholder="Description (optional)..."
          value={newTaskDesc}
          onChange={(e) => setNewTaskDesc(e.target.value)}
          className="mc-input mc-input-wide"
        />
        <button type="submit" className="mc-btn mc-btn-primary glow-blue">
          + Create Task
        </button>
      </form>

      {loading ? (
        <div className="mc-loading">
          <div className="mc-spinner" />
          <span>Loading missions...</span>
        </div>
      ) : (
        <div className="mc-board">
          {COLUMNS.map((col) => (
            <div key={col.id} className="mc-column">
              <h3 className="mc-column-header" style={{ color: col.color }}>
                {col.label}
                <span className="mc-count">{getJobsByStatus(col.id).length}</span>
              </h3>
              <div className="mc-cards">
                {getJobsByStatus(col.id).map((job) => (
                  <div key={job.id} className="mc-card">
                    <div className="mc-card-title">{job.title}</div>
                    {job.description && (
                      <div className="mc-card-desc">
                        {job.description.slice(0, 100)}
                        {job.description.length > 100 ? "..." : ""}
                      </div>
                    )}
                    <div className="mc-card-meta">Created: {formatDate(job.created_at)}</div>

                    <div className="mc-card-actions">
                      {job.status === "pending" && (
                        <button
                          onClick={() => assignAgent(job.id)}
                          disabled={assigning === job.id}
                          className="mc-btn mc-btn-sm mc-btn-accent"
                        >
                          {assigning === job.id ? "Assigning..." : "🤖 Assign Agent"}
                        </button>
                      )}

                      {job.status === "running" && (
                        <button
                          onClick={() => checkAgentStatus(job)}
                          className="mc-btn mc-btn-sm mc-btn-warn"
                        >
                          👁️ Check Status
                        </button>
                      )}

                      {job.result_summary?.startsWith("Branch:") && (
                        <span className="mc-badge">
                          {job.result_summary.replace("Branch: ", "").slice(0, 25)}...
                        </span>
                      )}

                      {job.result_summary?.includes("github.com") && (
                        <a
                          href={
                            job.result_summary.match(/https:\/\/github\.com\/[^\s]+/)?.[0] || "#"
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mc-btn mc-btn-sm mc-btn-link"
                        >
                          🔗 View PR
                        </a>
                      )}

                      <button
                        onClick={() => setConfirmDelete(job)}
                        disabled={deleting === job.id}
                        className="mc-btn mc-btn-sm mc-btn-danger"
                        title="Delete task"
                      >
                        {deleting === job.id ? "..." : "🗑️"}
                      </button>
                    </div>

                    {job.result_summary && !job.result_summary.includes("github.com") && (
                      <div className="mc-card-result">{job.result_summary.slice(0, 50)}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Logs Panel */}
      {logs.length > 0 && (
        <div className="mc-logs">
          <div className="mc-logs-header">
            <strong>📋 Activity Log</strong>
            <button onClick={() => setLogs([])} className="mc-btn-clear">
              Clear
            </button>
          </div>
          <div className="mc-logs-content">
            {logs.slice(-10).map((log, i) => (
              <div
                key={i}
                className={`mc-log-line ${log.startsWith("✓") ? "success" : log.startsWith("✗") ? "error" : ""}`}
              >
                {log}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Agent Status Modal */}
      {selectedJob && agentStatus && (
        <>
          <div className="mc-modal-backdrop" onClick={() => setSelectedJob(null)} />
          <div className="mc-modal">
            <h3 className="mc-modal-title">
              <span className="gradient-text">🤖 Agent Status</span>
            </h3>
            <div className="mc-modal-content">
              <p>
                <strong>Task:</strong> {selectedJob.title}
              </p>
              <p>
                <strong>State:</strong> {agentStatus.state}
              </p>
              <p>
                <strong>Active:</strong> {agentStatus.isActive ? "Yes" : "No"}
              </p>
              <p>
                <strong>Messages:</strong> {agentStatus.messageCount}
              </p>
              <p>
                <strong>Last Activity:</strong>{" "}
                {agentStatus.lastActivity ? formatDate(agentStatus.lastActivity) : "N/A"}
              </p>
            </div>
            <button onClick={() => setSelectedJob(null)} className="mc-btn mc-btn-secondary">
              Close
            </button>
          </div>
        </>
      )}

      {/* Delete Confirmation Modal */}
      {confirmDelete && (
        <>
          <div className="mc-modal-backdrop" onClick={() => setConfirmDelete(null)} />
          <div className="mc-modal">
            <h3 className="mc-modal-title" style={{ color: "var(--status-failed)" }}>
              🗑️ Delete Task?
            </h3>
            <div className="mc-modal-content">
              <p>
                Are you sure you want to delete <strong>{confirmDelete.title}</strong>?
              </p>
              <p style={{ color: "var(--text-muted)", fontSize: "14px" }}>
                This action cannot be undone.
              </p>
            </div>
            <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDelete(null)} className="mc-btn mc-btn-secondary">
                Cancel
              </button>
              <button
                onClick={() => deleteTask(confirmDelete.id)}
                disabled={deleting === confirmDelete.id}
                className="mc-btn mc-btn-danger"
              >
                {deleting === confirmDelete.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

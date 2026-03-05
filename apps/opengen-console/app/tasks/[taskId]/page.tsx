"use client";

import { useEffect, useState } from "react";
import { ConsoleShell } from "../../../components/console-shell";
import type { StoredTask } from "../../../lib/task-store";

interface TaskDetailPageProps {
  params: Promise<{ taskId: string }>;
}

export default function TaskDetailPage({ params }: TaskDetailPageProps) {
  const [taskId, setTaskId] = useState("");
  const [task, setTask] = useState<StoredTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadDetail() {
      try {
        const resolved = await params;
        setTaskId(resolved.taskId);

        const response = await fetch(`/api/tasks/${encodeURIComponent(resolved.taskId)}`);
        const payload = (await response.json()) as StoredTask & { error?: string };

        if (!response.ok) {
          throw new Error(payload.error || "Failed to load task detail");
        }

        setTask(payload);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    }

    void loadDetail();
  }, [params]);

  return (
    <ConsoleShell title={`Task ${taskId || "Detail"}`}>
      {loading ? <p>Loading task detail...</p> : null}
      {!loading && error ? <p className="result-error">{error}</p> : null}
      {!loading && !error && task ? (
        <div className="task-detail">
          <p>
            <strong>Status:</strong> {task.status || "unknown"}
          </p>
          <p>
            <strong>Current stage:</strong> {task.current_stage || "-"}
          </p>
          <p>
            <a href="/tasks">Back to tasks</a>
          </p>
          <pre>{JSON.stringify(task, null, 2)}</pre>
        </div>
      ) : null}
    </ConsoleShell>
  );
}

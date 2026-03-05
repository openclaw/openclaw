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
          throw new Error(payload.error || "加载任务详情失败");
        }

        setTask(payload);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "未知错误");
      } finally {
        setLoading(false);
      }
    }

    void loadDetail();
  }, [params]);

  return (
    <ConsoleShell title={`任务 ${taskId || "详情"}`}>
      {loading ? <p>任务详情加载中...</p> : null}
      {!loading && error ? <p className="result-error">{error}</p> : null}
      {!loading && !error && task ? (
        <div className="task-detail">
          <p>
            <strong>状态：</strong> {task.status || "未知"}
          </p>
          <p>
            <strong>当前阶段：</strong> {task.current_stage || "-"}
          </p>
          <p>
            <a href="/tasks">返回任务列表</a>
          </p>
          <pre>{JSON.stringify(task, null, 2)}</pre>
        </div>
      ) : null}
    </ConsoleShell>
  );
}

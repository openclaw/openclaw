"use client";

import { useEffect, useState } from "react";
import { ConsoleShell } from "../../components/console-shell";

interface TaskItem {
  task_id: string;
  status?: string;
  current_stage?: string;
  created_at?: number;
  request?: {
    description?: string;
    type?: string;
  };
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadTasks() {
      try {
        const response = await fetch("/api/tasks");
        const payload = (await response.json()) as { items?: TaskItem[]; error?: string };
        if (!response.ok) {
          throw new Error(payload.error || "加载任务失败");
        }
        setTasks(payload.items || []);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "未知错误");
      } finally {
        setLoading(false);
      }
    }

    void loadTasks();
  }, []);

  const content = (() => {
    if (loading) {
      return <p>任务加载中...</p>;
    }
    if (error) {
      return <p className="result-error">{error}</p>;
    }
    if (tasks.length === 0) {
      return <p>暂时还没有任务历史。</p>;
    }
    return (
      <ul className="task-list">
        {tasks.map((task) => (
          <li key={task.task_id} className="task-list-item">
            <a href={`/tasks/${task.task_id}`}>
              {task.request?.description || task.task_id}
            </a>
            <div className="task-meta">
              <span>{task.status || "未知"}</span>
              <span>{task.request?.type || "暂无"}</span>
              <span>{task.current_stage || "-"}</span>
            </div>
          </li>
        ))}
      </ul>
    );
  })();

  return (
    <ConsoleShell title="任务">
      {content}
    </ConsoleShell>
  );
}

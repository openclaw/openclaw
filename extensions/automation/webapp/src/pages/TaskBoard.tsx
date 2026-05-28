import { useMemo, useState } from "react";
import "./TaskBoard.css";

type TaskStatus = "todo" | "running" | "done";

type TaskCard = {
  id: string;
  title: string;
  agent: string;
  status: TaskStatus;
};

type DragPayload = {
  taskId: string;
};

const statusTitle: Record<TaskStatus, string> = {
  todo: "待處理",
  running: "進行中",
  done: "已完成",
};

const initialTasks: TaskCard[] = [
  { id: "task-1", title: "整理 quote 狀態異常", agent: "Risk Officer", status: "todo" },
  { id: "task-2", title: "更新 paper 策略參數", agent: "Quant Researcher", status: "running" },
  { id: "task-3", title: "輸出學習摘要", agent: "Report Analyst", status: "done" },
];

function moveTaskToStatus(tasks: TaskCard[], taskId: string, nextStatus: TaskStatus): TaskCard[] {
  const index = tasks.findIndex((task) => task.id === taskId);
  if (index < 0) {
    return tasks;
  }
  const task = tasks[index];
  if (task.status === nextStatus) {
    return tasks;
  }
  const next = tasks.filter((item) => item.id !== taskId);
  return [...next, { ...task, status: nextStatus }];
}

export function TaskBoard() {
  const [tasks, setTasks] = useState<TaskCard[]>(initialTasks);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);

  const grouped = useMemo(() => {
    return {
      todo: tasks.filter((task) => task.status === "todo"),
      running: tasks.filter((task) => task.status === "running"),
      done: tasks.filter((task) => task.status === "done"),
    };
  }, [tasks]);

  function handleDrop(nextStatus: TaskStatus, data: DragPayload) {
    setTasks((prev) => moveTaskToStatus(prev, data.taskId, nextStatus));
    setDraggingTaskId(null);
  }

  return (
    <section className="task-board">
      <header className="task-board-header">
        <h1>任務看板</h1>
        <p>拖曳任務卡片到欄位以更新狀態。</p>
      </header>

      <div className="task-board-grid">
        {(Object.keys(statusTitle) as TaskStatus[]).map((status) => (
          <article
            key={status}
            className="task-column"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const raw = event.dataTransfer.getData("application/json");
              if (!raw) {
                return;
              }
              try {
                handleDrop(status, JSON.parse(raw) as DragPayload);
              } catch {
                // 忽略非法 drag payload
              }
            }}
          >
            <h2>
              {statusTitle[status]} <span>{grouped[status].length}</span>
            </h2>

            <div className="task-cards">
              {grouped[status].map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className={
                    draggingTaskId === task.id ? "task-card task-card-dragging" : "task-card"
                  }
                  draggable
                  onDragStart={(event) => {
                    setDraggingTaskId(task.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData(
                      "application/json",
                      JSON.stringify({ taskId: task.id } satisfies DragPayload),
                    );
                  }}
                  onDragEnd={() => setDraggingTaskId(null)}
                >
                  <strong>{task.title}</strong>
                  <span>{task.agent}</span>
                </button>
              ))}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

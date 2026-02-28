import type { Task } from "./types.js";

/** Format a task-completed system event for injection into a session. */
export function formatTaskCompletedEvent(task: Task): string {
  const who = task.concluido_por ? ` por ${task.concluido_por}` : "";
  const when = task.concluido_em
    ? ` em ${new Date(task.concluido_em).toLocaleString("pt-BR")}`
    : "";
  return `[iris-dashboard] Tarefa concluída${who}${when}: "${task.titulo}" (${task.id})`;
}

/** Format the heartbeat summary for the session context. */
export function formatHeartbeatSummary(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "[iris-dashboard] Nenhuma tarefa pendente ou em andamento.";
  }
  const lines = tasks.map((t) => {
    const prio = `P${t.prioridade}`;
    const venc = t.vencimento_em
      ? ` | vence: ${new Date(t.vencimento_em).toLocaleDateString("pt-BR")}`
      : "";
    const pessoa = t.pessoa ? ` | pessoa: ${t.pessoa}` : "";
    return `- [${t.status}] ${t.titulo} (${prio}${venc}${pessoa})`;
  });
  return `[iris-dashboard] Tarefas ativas:\n${lines.join("\n")}`;
}

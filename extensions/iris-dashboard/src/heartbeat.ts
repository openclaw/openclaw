import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { DashboardConfig } from "./config.js";
import type { SupabaseClient } from "./supabase.js";
import { supabaseFetchActiveTasksForHeartbeat } from "./supabase.js";
import type { Task } from "./types.js";

function priorityLabel(p: number): string {
  if (p === 1) return "🔴 CRÍTICA";
  if (p === 2) return "🟠 Alta";
  if (p === 3) return "🟡 Média";
  if (p === 4) return "🟢 Baixa";
  return "⚪ Mínima";
}

function statusLabel(s: string): string {
  if (s === "em_andamento") return "Em andamento";
  return "Pendente";
}

function formatTask(t: Task, idx: number): string {
  const lines: string[] = [];
  lines.push(`### ${idx}. ${t.titulo}`);
  if (t.descricao) lines.push(`> ${t.descricao}`);
  const meta: string[] = [
    `**Status:** ${statusLabel(t.status)}`,
    `**Prioridade:** ${priorityLabel(t.prioridade)}`,
    `**Categoria:** ${t.categoria}`,
  ];
  if (t.pessoa) meta.push(`**Pessoa:** ${t.pessoa}`);
  if (t.vencimento_em) {
    meta.push(`**Vencimento:** ${new Date(t.vencimento_em).toLocaleDateString("pt-BR")}`);
  }
  meta.push(`**Origem:** ${t.origem}`);
  meta.push(`**ID:** \`${t.id}\``);
  lines.push(meta.join(" | "));
  return lines.join("\n");
}

/** Generate HEARTBEAT.md with current active tasks. */
export async function generateHeartbeat(
  client: SupabaseClient,
  config: DashboardConfig,
  workspaceDir?: string,
): Promise<void> {
  let tasks: Task[];
  try {
    tasks = await supabaseFetchActiveTasksForHeartbeat(client);
  } catch (err: unknown) {
    console.error("[iris-dashboard] Heartbeat: failed to fetch tasks:", err);
    return;
  }

  const now = new Date();
  const dateStr = now.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });

  const urgent = tasks.filter((t) => t.prioridade <= 2);
  const outros = tasks.filter((t) => t.prioridade > 2);

  const sections: string[] = [
    `# HEARTBEAT - Iris Dashboard`,
    ``,
    `> Gerado em: ${dateStr}`,
    `> Tarefas ativas: ${tasks.length}`,
    ``,
  ];

  if (tasks.length === 0) {
    sections.push("**Nenhuma tarefa pendente ou em andamento.** ✅");
  } else {
    if (urgent.length > 0) {
      sections.push("## 🔴 Urgentes / Alta Prioridade");
      sections.push("");
      urgent.forEach((t, i) => {
        sections.push(formatTask(t, i + 1));
        sections.push("");
      });
    }

    if (outros.length > 0) {
      sections.push("## 📋 Demais Tarefas");
      sections.push("");
      outros.forEach((t, i) => {
        sections.push(formatTask(t, urgent.length + i + 1));
        sections.push("");
      });
    }
  }

  const content = sections.join("\n");

  // Resolve output path relative to workspaceDir if provided
  const outputPath = workspaceDir
    ? resolve(workspaceDir, config.heartbeatOutputFile)
    : resolve(process.cwd(), config.heartbeatOutputFile);

  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, content, "utf-8");
    console.log(`[iris-dashboard] HEARTBEAT written to ${outputPath} (${tasks.length} tasks)`);
  } catch (err: unknown) {
    console.error("[iris-dashboard] Heartbeat: failed to write file:", err);
  }
}

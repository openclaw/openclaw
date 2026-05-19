import type { InteractiveReply } from "./types.js";
import { buildBreadcrumb } from "./main-menu.js";
import {
  WORKFLOW_TEMPLATES,
  type WorkflowDefinition,
  type WorkflowExecution,
} from "../tools/workflow-types.js";

export function buildWorkflowList(
  workflows?: WorkflowDefinition[],
  pinnedIds?: string[],
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "工作流");
  const wfs = workflows ?? WORKFLOW_TEMPLATES;
  const pinned = new Set(pinnedIds ?? []);

  const sorted = [...wfs].sort((a, b) => {
    const ap = pinned.has(a.id) ? 0 : 1;
    const bp = pinned.has(b.id) ? 0 : 1;
    return ap - bp;
  });

  const lines = sorted.map((w) => {
    const pin = pinned.has(w.id) ? "📌 " : "";
    return `${pin}<b>${w.name}</b> — ${w.description}`;
  });

  const buttons = sorted.slice(0, 3).map((w) => ({
    label: `▶️ ${w.name}`,
    value: `sc:wf:run:${w.id}`,
    style: "primary" as const,
  }));

  const moreButtons =
    sorted.length > 3
      ? sorted.slice(3, 6).map((w) => ({
          label: `▶️ ${w.name}`,
          value: `sc:wf:run:${w.id}`,
          style: "primary" as const,
        }))
      : [];

  const blocks: InteractiveReply["blocks"] = [
    { type: "text", text: `${nav}\n\n🔄 <b>工作流</b> (${wfs.length})\n\n${lines.join("\n")}` },
    { type: "buttons", buttons },
  ];

  if (moreButtons.length > 0) {
    blocks.push({ type: "buttons", buttons: moreButtons });
  }

  blocks.push({
    type: "buttons",
    buttons: [{ label: "← 首頁", value: "sc:home", style: "primary" }],
  });

  return { blocks };
}

const STEP_EMOJI: Record<string, string> = {
  pending: "⏳",
  running: "🔄",
  done: "✅",
  error: "❌",
  skipped: "⏭️",
};

export function buildWorkflowProgress(
  execution: WorkflowExecution,
  workflow: WorkflowDefinition,
  elapsed?: number,
): InteractiveReply {
  const nav = buildBreadcrumb("首頁", "工作流", workflow.name);

  const nodeLines = workflow.nodes.map((node, i) => {
    const result = execution.nodeResults[node.id];
    const status = result?.status ?? "pending";
    const emoji = STEP_EMOJI[status] ?? "⏳";

    let detail = "";
    if (result?.error) {
      detail = ` — <i>${result.error.slice(0, 50)}</i>`;
    } else if (status === "running") {
      detail = " ...";
    }

    return `${emoji} ${i + 1}/${workflow.nodes.length} ${node.label}${detail}`;
  });

  const elapsedLine =
    elapsed != null ? `\n\n⏱ ${(elapsed / 1000).toFixed(1)}s` : "";

  const isActive =
    execution.status === "running" || execution.status === "awaiting_confirm";

  const actionButtons = isActive
    ? [{ label: "⏹️ 取消", value: `sc:wf:stop:${execution.id}`, style: "danger" as const }]
    : [
        { label: "🔄 再執行", value: `sc:wf:run:${execution.workflowId}`, style: "primary" as const },
        { label: "← 工作流", value: "sc:wf", style: "primary" as const },
      ];

  return {
    blocks: [
      {
        type: "text",
        text: `${nav}\n\n${nodeLines.join("\n")}${elapsedLine}`,
      },
      { type: "buttons", buttons: actionButtons },
    ],
  };
}

export function buildWorkflowDone(
  workflow: WorkflowDefinition,
  success: boolean,
  summary?: string,
): InteractiveReply {
  const emoji = success ? "🎉" : "❌";
  const status = success ? "完成" : "失敗";
  const summaryLine = summary ? `\n\n${summary}` : "";

  return {
    blocks: [
      {
        type: "text",
        text: `${emoji} <b>${workflow.name}</b> ${status}${summaryLine}`,
      },
      {
        type: "buttons",
        buttons: [
          { label: "🔄 再執行", value: `sc:wf:run:${workflow.id}`, style: "primary" },
          { label: "← 工作流", value: "sc:wf", style: "primary" },
          { label: "← 首頁", value: "sc:home", style: "primary" },
        ],
      },
    ],
  };
}

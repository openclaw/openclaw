import type { HealthData } from "../api";

export function renderHealthPanel(data: HealthData): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.panel = "health_panel";

  if (data.error) {
    panel.innerHTML = `<div class="panel-header"><h2>System Health</h2></div><div class="panel-error">${data.error}</div>`;
    return panel;
  }

  const warningCount = data.warnings.length;
  const overallColor = warningCount === 0 ? "var(--accent-green)" : "var(--accent-yellow)";
  const overallLabel =
    warningCount === 0 ? "All Clear" : `${warningCount} warning${warningCount > 1 ? "s" : ""}`;

  // Cooldown status
  const cooldownHtml = data.cooldown.active
    ? `<div class="health-row"><span class="status-dot" style="background:var(--accent-yellow)"></span> Cooldown active</div>`
    : "";

  // Queue depth
  const queueDepth = data.queue.scheduled_actions_pending;
  const queueHtml =
    queueDepth !== null
      ? `<div class="health-row"><span class="status-dot" style="background:var(--accent-green)"></span> Queue: ${queueDepth} pending</div>`
      : "";

  // Warnings list
  let warningsHtml = "";
  if (warningCount > 0) {
    const items = data.warnings.map((w) => `<li class="warning-item">${w}</li>`).join("");
    warningsHtml = `<ul class="warnings-list">${items}</ul>`;
  }

  // Notion compliance
  const notion = data.notion_compliance_status;
  let notionHtml = "";
  if (notion && !notion.error) {
    const dot = notion.compliant ? "var(--accent-green)" : "var(--accent-yellow)";
    const label = notion.compliant
      ? "Compliant"
      : `${String(notion.drift_issue_count)} drift issues`;
    notionHtml = `<div class="health-row"><span class="status-dot" style="background:${dot}"></span> Notion: ${label}</div>`;
  }

  panel.innerHTML = `
    <div class="panel-header">
      <h2>System Health</h2>
      <button class="info-icon" data-panel-key="health_panel" aria-label="Panel info">&#9432;</button>
    </div>

    <div class="health-overall" style="color:${overallColor}">
      <span class="status-dot" style="background:${overallColor}"></span>
      ${overallLabel}
    </div>

    ${cooldownHtml}
    ${queueHtml}
    ${notionHtml}
    ${warningsHtml}
  `;

  return panel;
}

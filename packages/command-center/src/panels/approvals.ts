import type { ApprovalsData } from "../api";

export function renderApprovalsPanel(data: ApprovalsData): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.panel = "approvals_panel";

  const count = data.pending_count;
  const countColor = count > 0 ? "var(--accent-yellow)" : "var(--accent-green)";
  const countLabel =
    count === 0 ? "No actions waiting" : `${count} action${count > 1 ? "s" : ""} waiting`;

  let itemsHtml = "";
  if (data.items.length > 0) {
    const rows = data.items
      .map(
        (item) => `
        <div class="approval-item">
          <span class="approval-type">${item.action_type}</span>
          <span class="approval-desc">${item.description}</span>
          <span class="approval-time muted">${formatTime(item.created_at)}</span>
        </div>`,
      )
      .join("");
    itemsHtml = `<div class="approval-list">${rows}</div>`;
  }

  panel.innerHTML = `
    <div class="panel-header">
      <h2>Approvals</h2>
      <button class="info-icon" data-panel-key="approvals_panel" aria-label="Panel info">&#9432;</button>
    </div>

    <div class="stat-row">
      <span class="stat-value" style="color:${countColor}">${count}</span>
      <span class="stat-label">${countLabel}</span>
    </div>

    ${itemsHtml}
  `;

  return panel;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

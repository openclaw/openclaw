import type { TodayData } from "../api";

const COLOR_MAP: Record<string, string> = {
  green: "var(--accent-green)",
  yellow: "var(--accent-yellow)",
  red: "var(--accent-red)",
};

export function renderTodayPanel(data: TodayData): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.panel = "today_panel";

  if (data.error) {
    panel.innerHTML = `<div class="panel-header"><h2>Today</h2></div><div class="panel-error">${data.error}</div>`;
    return panel;
  }

  const fd = data.brands.fulldigital;
  const cm = data.brands.cutmv;
  const fdColor = COLOR_MAP[fd.trend_color] ?? "var(--text-muted)";
  const cmColor = COLOR_MAP[cm.trend_color] ?? "var(--text-muted)";

  // Overdue section
  let overdueHtml = "";
  if (data.overdue_count > 0) {
    const items = data.overdue_list
      .slice(0, 5)
      .map(
        (item) =>
          `<div class="overdue-item"><span class="overdue-dot"></span>${item.title} <span class="muted">(${item.brand})</span></div>`,
      )
      .join("");
    overdueHtml = `
      <div class="overdue-section">
        <span class="overdue-badge">${data.overdue_count} overdue</span>
        ${items}
      </div>`;
  }

  // Up next (focus window events)
  let upNextHtml = "";
  if (data.focus.up_next.length > 0) {
    const rows = data.focus.up_next
      .slice(0, 5)
      .map(
        (ev) => `
        <tr>
          <td class="muted">${ev.time}</td>
          <td>${ev.title}${ev.conflict ? ' <span class="conflict-badge">!</span>' : ""}</td>
          <td class="muted">${ev.brand}</td>
        </tr>`,
      )
      .join("");
    upNextHtml = `<table class="schedule-table">${rows}</table>`;
  }

  panel.innerHTML = `
    <div class="panel-header">
      <h2>Today</h2>
      <button class="info-icon" data-panel-key="today_panel" aria-label="Panel info">&#9432;</button>
    </div>

    <div class="brand-chip" style="border-left: 3px solid ${fdColor}">
      <strong>Full Digital</strong> &mdash; ${fd.kpi_line}
      ${fd.goal_chip ? `<span class="goal-chip">${fd.goal_chip}</span>` : ""}
    </div>
    <div class="brand-chip" style="border-left: 3px solid ${cmColor}">
      <strong>CUTMV</strong> &mdash; ${cm.kpi_line}
      ${cm.goal_chip ? `<span class="goal-chip">${cm.goal_chip}</span>` : ""}
    </div>

    ${upNextHtml}
    ${overdueHtml}

    <div class="panel-actions">
      <button class="btn-primary" id="start-day-btn">Start the Day</button>
      <span class="action-status" id="start-day-status"></span>
    </div>
  `;

  return panel;
}

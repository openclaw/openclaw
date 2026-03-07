import type { ScheduleData, TodayData } from "../api";

export function renderSchedulePanel(schedule: ScheduleData, today: TodayData): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.dataset.panel = "schedule_panel";

  if (schedule.error) {
    panel.innerHTML = `<div class="panel-header"><h2>Schedule</h2></div><div class="panel-error">${schedule.error}</div>`;
    return panel;
  }

  const counts = schedule.event_counts;
  const conflictBadge =
    counts.conflicts > 0
      ? `<span class="conflict-badge">${counts.conflicts} conflict${counts.conflicts > 1 ? "s" : ""}</span>`
      : "";

  // Deadline rows from today data
  let deadlineHtml = "";
  if (today.focus?.deadlines?.length > 0) {
    const rows = today.focus.deadlines
      .slice(0, 5)
      .map(
        (d) => `
        <tr>
          <td class="deadline-label">Due</td>
          <td>${d.title}</td>
          <td class="muted">${d.brand}</td>
        </tr>`,
      )
      .join("");
    deadlineHtml = `
      <h3 class="sub-heading">Deadlines</h3>
      <table class="schedule-table">${rows}</table>`;
  }

  // Source breakdown
  const sources = Object.entries(counts.by_source)
    .map(([src, n]) => `${src}: ${n}`)
    .join(" &middot; ");

  panel.innerHTML = `
    <div class="panel-header">
      <h2>Schedule</h2>
      <button class="info-icon" data-panel-key="schedule_panel" aria-label="Panel info">&#9432;</button>
    </div>

    <div class="stat-row">
      <span class="stat-value">${counts.total_active}</span>
      <span class="stat-label">active events</span>
      ${conflictBadge}
    </div>

    ${sources ? `<div class="muted" style="margin-bottom:8px">${sources}</div>` : ""}
    ${deadlineHtml}
  `;

  return panel;
}

import type { TodayData } from "../api";

const COLOR_MAP: Record<string, string> = {
  green: "var(--accent-green)",
  yellow: "var(--accent-yellow)",
  red: "var(--accent-red)",
};

export function renderKpiChipsPanel(data: TodayData): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "panel panel-kpi";
  panel.dataset.panel = "kpi_chips";

  if (data.error) {
    panel.innerHTML = `<div class="panel-header"><h2>Brand KPIs</h2></div><div class="panel-error">${data.error}</div>`;
    return panel;
  }

  const brands = [
    { key: "fulldigital", label: "Full Digital", data: data.brands.fulldigital },
    { key: "cutmv", label: "CUTMV", data: data.brands.cutmv },
  ];

  const chips = brands
    .map((b) => {
      const color = COLOR_MAP[b.data.trend_color] ?? "var(--text-muted)";
      return `
        <div class="kpi-chip" style="border-left: 3px solid ${color}">
          <div class="kpi-chip-label">${b.label}</div>
          <div class="kpi-chip-value">${b.data.kpi_line}</div>
          ${b.data.goal_chip ? `<div class="kpi-chip-goal">${b.data.goal_chip}</div>` : ""}
        </div>`;
    })
    .join("");

  panel.innerHTML = `
    <div class="panel-header">
      <h2>Brand KPIs</h2>
      <button class="info-icon" data-panel-key="kpi_chips" aria-label="Panel info">&#9432;</button>
    </div>
    <div class="kpi-chips-grid">${chips}</div>
  `;

  return panel;
}

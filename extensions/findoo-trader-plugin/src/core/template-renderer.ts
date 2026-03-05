/**
 * Dashboard template loading and HTML rendering.
 * Reads HTML/CSS template files from the dashboard/ directory and injects
 * data + styles at render time.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type UnifiedTemplate = {
  html: string;
  css: string;
  sharedCss: string;
};

export type DashboardTemplates = {
  finance: { html: string; css: string };
  trading: { html: string; css: string };
  commandCenter: { html: string; css: string };
  missionControl: { html: string; css: string };
  overview: UnifiedTemplate;
  tradingDesk: UnifiedTemplate;
  strategyLab: UnifiedTemplate;
  /** v3 5-Tab pages */
  strategy: UnifiedTemplate;
  trader: UnifiedTemplate;
  flow: UnifiedTemplate;
  setting: UnifiedTemplate;
};

/** Load all dashboard templates from the given directory. Missing files are empty strings. */
export function loadDashboardTemplates(dashboardDir: string): DashboardTemplates {
  const load = (htmlFile: string, cssFile: string) => {
    try {
      return {
        html: readFileSync(join(dashboardDir, htmlFile), "utf-8"),
        css: readFileSync(join(dashboardDir, cssFile), "utf-8"),
      };
    } catch {
      return { html: "", css: "" };
    }
  };

  let sharedCss = "";
  try {
    sharedCss = readFileSync(join(dashboardDir, "unified-dashboard.css"), "utf-8");
  } catch {
    /* unified CSS not yet available */
  }

  const loadUnified = (htmlFile: string, cssFile: string): UnifiedTemplate => {
    let html = "";
    let css = "";
    try {
      html = readFileSync(join(dashboardDir, htmlFile), "utf-8");
    } catch {}
    try {
      css = readFileSync(join(dashboardDir, cssFile), "utf-8");
    } catch {}
    return { html, css, sharedCss };
  };

  return {
    finance: load("finance-dashboard.html", "finance-dashboard.css"),
    trading: load("trading-dashboard.html", "trading-dashboard.css"),
    commandCenter: load("command-center.html", "command-center.css"),
    missionControl: load("mission-control.html", "mission-control.css"),
    overview: loadUnified("overview.html", "overview.css"),
    tradingDesk: loadUnified("trading-desk.html", "trading-desk.css"),
    strategyLab: loadUnified("strategy-lab.html", "strategy-lab.css"),
    strategy: loadUnified("strategy.html", "strategy.css"),
    trader: loadUnified("trader.html", "trader.css"),
    flow: loadUnified("flow.html", "flow.css"),
    setting: loadUnified("setting.html", "setting.css"),
  };
}

/** Render a dashboard HTML page by injecting CSS and JSON data into the template. */
export function renderDashboard(
  template: { html: string; css: string },
  data: unknown,
  cssPlaceholder: string,
  dataPlaceholder: RegExp | string,
): string | null {
  if (!template.html || !template.css) return null;

  const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
  return template.html.replace(cssPlaceholder, template.css).replace(dataPlaceholder, safeJson);
}

/** Render a unified dashboard page with shared + page-specific CSS. */
export function renderUnifiedDashboard(template: UnifiedTemplate, data: unknown): string | null {
  if (!template.html || !template.sharedCss) return null;

  const safeJson = JSON.stringify(data).replace(/<\//g, "<\\/");
  return template.html
    .replace("/*__SHARED_CSS__*/", template.sharedCss)
    .replace("/*__PAGE_CSS__*/", template.css || "")
    .replace(/\/\*__PAGE_DATA__\*\/\s*\{\}/, safeJson);
}

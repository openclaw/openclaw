import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  loadDashboardTemplates,
  renderDashboard,
  renderUnifiedDashboard,
} from "../../src/core/template-renderer.js";
import type { UnifiedTemplate } from "../../src/core/template-renderer.js";

describe("loadDashboardTemplates", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dashboard-test-"));
  });

  it("returns empty strings for missing files", () => {
    const templates = loadDashboardTemplates(dir);
    expect(templates.finance.html).toBe("");
    expect(templates.finance.css).toBe("");
    expect(templates.overview.html).toBe("");
    expect(templates.overview.sharedCss).toBe("");
  });

  it("loads existing template files", () => {
    writeFileSync(join(dir, "finance-dashboard.html"), "<html>finance</html>");
    writeFileSync(join(dir, "finance-dashboard.css"), ".fin { color: red }");
    writeFileSync(join(dir, "unified-dashboard.css"), ".shared { color: blue }");
    writeFileSync(join(dir, "overview.html"), "<html>overview</html>");
    writeFileSync(join(dir, "overview.css"), ".ov { color: green }");

    const templates = loadDashboardTemplates(dir);
    expect(templates.finance.html).toBe("<html>finance</html>");
    expect(templates.finance.css).toBe(".fin { color: red }");
    expect(templates.overview.html).toBe("<html>overview</html>");
    expect(templates.overview.css).toBe(".ov { color: green }");
    expect(templates.overview.sharedCss).toBe(".shared { color: blue }");
  });

  it("loads all v3 5-Tab templates", () => {
    for (const tab of ["strategy", "trader", "flow", "setting"]) {
      writeFileSync(join(dir, `${tab}.html`), `<html>${tab}</html>`);
      writeFileSync(join(dir, `${tab}.css`), `.${tab} {}`);
    }
    writeFileSync(join(dir, "unified-dashboard.css"), ".shared {}");

    const templates = loadDashboardTemplates(dir);
    expect(templates.strategy.html).toBe("<html>strategy</html>");
    expect(templates.trader.html).toBe("<html>trader</html>");
    expect(templates.flow.html).toBe("<html>flow</html>");
    expect(templates.setting.html).toBe("<html>setting</html>");
  });
});

describe("renderDashboard", () => {
  it("returns null if html is empty", () => {
    expect(renderDashboard({ html: "", css: ".test{}" }, {}, "/*CSS*/", /DATA/)).toBeNull();
  });

  it("returns null if css is empty", () => {
    expect(renderDashboard({ html: "<div>test</div>", css: "" }, {}, "/*CSS*/", /DATA/)).toBeNull();
  });

  it("injects CSS and data into template", () => {
    const html = '<style>/*CSS*/</style><script>var data = "DATA";</script>';
    const css = ".dashboard { color: red; }";
    const data = { equity: 100_000, pnl: 5_000 };

    const result = renderDashboard({ html, css }, data, "/*CSS*/", "DATA");
    expect(result).toContain(".dashboard { color: red; }");
    expect(result).toContain('"equity":100000');
    expect(result).toContain('"pnl":5000');
  });

  it("escapes </script> in JSON data to prevent XSS", () => {
    const html = '<style>/*CSS*/</style><script>var d = "DATA";</script>';
    const css = ".x {}";
    const data = { html: "</script><script>alert(1)</script>" };

    const result = renderDashboard({ html, css }, data, "/*CSS*/", "DATA")!;
    expect(result).not.toContain("</script><script>alert(1)");
    expect(result).toContain("<\\/script>");
  });

  it("supports regex data placeholder", () => {
    const html = "<style>/*CSS*/</style><script>var d = __DATA_PLACEHOLDER__;</script>";
    const css = ".x {}";
    const result = renderDashboard({ html, css }, { ok: true }, "/*CSS*/", /__DATA_PLACEHOLDER__/);
    expect(result).toContain('"ok":true');
  });
});

describe("renderUnifiedDashboard", () => {
  it("returns null if html is empty", () => {
    const t: UnifiedTemplate = { html: "", css: ".page{}", sharedCss: ".shared{}" };
    expect(renderUnifiedDashboard(t, {})).toBeNull();
  });

  it("returns null if sharedCss is empty", () => {
    const t: UnifiedTemplate = { html: "<div>test</div>", css: ".page{}", sharedCss: "" };
    expect(renderUnifiedDashboard(t, {})).toBeNull();
  });

  it("injects shared CSS, page CSS, and data", () => {
    const t: UnifiedTemplate = {
      html: "<style>/*__SHARED_CSS__*/</style><style>/*__PAGE_CSS__*/</style><script>var d = /*__PAGE_DATA__*/ {};</script>",
      css: ".page { font-size: 14px; }",
      sharedCss: ".shared { color: blue; }",
    };
    const data = { strategies: 5, equity: 50_000 };

    const result = renderUnifiedDashboard(t, data)!;
    expect(result).toContain(".shared { color: blue; }");
    expect(result).toContain(".page { font-size: 14px; }");
    expect(result).toContain('"strategies":5');
    expect(result).toContain('"equity":50000');
  });

  it("escapes </script> in unified template data", () => {
    const t: UnifiedTemplate = {
      html: "<style>/*__SHARED_CSS__*/</style><style>/*__PAGE_CSS__*/</style><script>var d = /*__PAGE_DATA__*/ {};</script>",
      css: "",
      sharedCss: ".s{}",
    };
    const result = renderUnifiedDashboard(t, { x: "</script>" })!;
    expect(result).toContain("<\\/script>");
    expect(result).not.toContain('</script>"');
  });

  it("works with empty page CSS", () => {
    const t: UnifiedTemplate = {
      html: "<style>/*__SHARED_CSS__*/</style><style>/*__PAGE_CSS__*/</style><script>var d = /*__PAGE_DATA__*/ {};</script>",
      css: "",
      sharedCss: ".shared{}",
    };
    const result = renderUnifiedDashboard(t, { ok: true })!;
    expect(result).toBeDefined();
    expect(result).toContain(".shared{}");
  });
});

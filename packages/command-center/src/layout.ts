const SIMPLE_MODE_KEY = "openclaw_simple_mode";

export function isSimpleMode(): boolean {
  return localStorage.getItem(SIMPLE_MODE_KEY) === "1";
}

export function setSimpleMode(on: boolean): void {
  localStorage.setItem(SIMPLE_MODE_KEY, on ? "1" : "0");
  document.body.classList.toggle("simple-mode", on);
}

export function createLayout(): HTMLElement {
  const layout = document.createElement("div");
  layout.className = "cc-layout";

  layout.innerHTML = `
    <header class="cc-header">
      <div class="cc-logo">OpenClaw</div>
      <div id="prompt-bar-mount"></div>
      <div class="cc-header-right">
        <span class="connection-indicator" id="connection-indicator">
          <span class="conn-dot" id="conn-dot"></span>
          <span class="conn-label" id="conn-label">Connecting...</span>
        </span>
        <label class="simple-toggle">
          <input type="checkbox" id="simple-mode-toggle" />
          <span>Simple</span>
        </label>
        <button class="tour-btn" id="tour-btn" title="Take the tour">?</button>
      </div>
    </header>

    <div class="cc-grid">
      <div class="cc-col-left">
        <div id="panel-today"></div>
        <div id="panel-schedule"></div>
      </div>
      <div class="cc-col-right">
        <div id="panel-kpi" class="advanced-panel"></div>
        <div id="panel-health" class="advanced-panel"></div>
        <div id="panel-approvals"></div>
      </div>
    </div>

    <footer class="cc-footer">
      <div class="footer-left">
        <span class="muted">Last refresh: <span id="last-refresh">--</span></span>
        <button class="refresh-btn" id="refresh-btn" title="Refresh now">&#8635;</button>
      </div>
      <div class="footer-right">
        <span class="muted" id="token-status"></span>
      </div>
    </footer>
  `;

  // Simple mode toggle
  const toggle = layout.querySelector<HTMLInputElement>("#simple-mode-toggle")!;
  toggle.checked = isSimpleMode();
  setSimpleMode(toggle.checked);

  toggle.addEventListener("change", () => {
    setSimpleMode(toggle.checked);
  });

  return layout;
}

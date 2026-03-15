import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";

@customElement("usage-mode-native")
export class UsageModeNative extends LitElement {
  @state() private currentTime = new Date().toLocaleTimeString();
  private timeIntervalId?: number;

  connectedCallback() {
    super.connectedCallback();
    this.updateTime();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.timeIntervalId !== undefined) {
      clearInterval(this.timeIntervalId);
    }
  }

  private updateTime() {
    this.timeIntervalId = setInterval(() => {
      this.currentTime = new Date().toLocaleTimeString();
    }, 1000) as unknown as number;
  }

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: #0a1628;
      color: #e2e8f0;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
    }

    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 24px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      height: 100%;
      box-sizing: border-box;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.5);
    }

    .header-title {
      font-size: 18px;
      font-weight: 600;
      color: #f1f5f9;
    }

    .header-time {
      font-size: 14px;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }

    .main-content {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      overflow: hidden;
    }

    .panel {
      background: rgba(15, 23, 42, 0.4);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.4);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .panel-header {
      font-size: 15px;
      font-weight: 500;
      color: #cbd5e1;
      padding-bottom: 12px;
      border-bottom: 1px solid rgba(51, 65, 85, 0.3);
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.6;
    }

    .status-indicator {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 6px;
      font-size: 13px;
      color: #86efac;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .footer {
      padding: 16px 20px;
      background: rgba(15, 23, 42, 0.4);
      border-radius: 8px;
      border: 1px solid rgba(51, 65, 85, 0.4);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 13px;
      color: #64748b;
    }

    @media (max-width: 768px) {
      .main-content {
        grid-template-columns: 1fr;
      }
    }
  `;

  render() {
    return html`
      <div class="container">
        <div class="header">
          <div class="header-title">OpenClaw Native</div>
          <div class="header-time">${this.currentTime}</div>
        </div>

        <div class="main-content">
          <div class="panel">
            <div class="panel-header">Overview</div>
            <div class="panel-content">
              <div class="status-indicator">
                <span class="status-dot"></span>
                <span>System Ready</span>
              </div>
              <p style="margin-top: 16px;">
                This is the Native usage mode - a stable, structured baseline for your workspace.
              </p>
            </div>
          </div>

          <div class="panel">
            <div class="panel-header">Activity</div>
            <div class="panel-content">
              <p>No recent activity to display.</p>
            </div>
          </div>
        </div>

        <div class="footer">
          <span>Native Mode</span>
          <span>Ready</span>
        </div>
      </div>
    `;
  }
}

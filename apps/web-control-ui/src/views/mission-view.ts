import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";

/**
 * Mission usage-mode view
 * Inspired by mission-control/command-center aesthetics:
 * - Structured grid layout
 * - Status-organized information
 * - Operator confidence through clear hierarchy
 * - Card-based clarity
 */
@customElement("mission-view")
export class MissionView extends LitElement {
  @state() private systemStatus: "operational" | "degraded" | "offline" = "operational";
  @state() private activeWorkflows: number = 3;
  @state() private completedTasks: number = 47;
  @state() private uptime: string = "99.8%";

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: linear-gradient(135deg, #0a1628 0%, #0f1c2e 100%);
      color: #e2e8f0;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      overflow: auto;
    }

    .mission-container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    .mission-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
    }

    .mission-title {
      font-size: 28px;
      font-weight: 600;
      letter-spacing: -0.02em;
      color: #f1f5f9;
      margin: 0;
    }

    .mission-subtitle {
      font-size: 14px;
      color: #94a3b8;
      margin-top: 4px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: rgba(15, 23, 42, 0.6);
      border-radius: 8px;
      border: 1px solid rgba(148, 163, 184, 0.2);
    }

    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 12px rgba(16, 185, 129, 0.6);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .status-dot.degraded {
      background: #f59e0b;
      box-shadow: 0 0 12px rgba(245, 158, 11, 0.6);
    }

    .status-dot.offline {
      background: #ef4444;
      box-shadow: 0 0 12px rgba(239, 68, 68, 0.6);
    }

    .status-text {
      font-size: 14px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .mission-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 20px;
      margin-bottom: 24px;
    }

    .mission-card {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 24px;
      transition: all 0.2s ease;
    }

    .mission-card:hover {
      border-color: rgba(148, 163, 184, 0.4);
      background: rgba(15, 23, 42, 0.7);
      transform: translateY(-2px);
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }

    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: #f1f5f9;
      margin: 0;
    }

    .card-badge {
      font-size: 12px;
      padding: 4px 10px;
      background: rgba(59, 130, 246, 0.2);
      color: #60a5fa;
      border-radius: 6px;
      font-weight: 500;
    }

    .card-metric {
      font-size: 36px;
      font-weight: 700;
      color: #3b82f6;
      margin: 12px 0;
      line-height: 1;
    }

    .card-label {
      font-size: 13px;
      color: #94a3b8;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .workflow-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .workflow-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }

    .workflow-item:last-child {
      border-bottom: none;
    }

    .workflow-name {
      font-size: 14px;
      color: #e2e8f0;
    }

    .workflow-status {
      font-size: 12px;
      padding: 4px 8px;
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border-radius: 4px;
      font-weight: 500;
    }

    .command-panel {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 12px;
      padding: 24px;
      margin-top: 24px;
    }

    .command-title {
      font-size: 18px;
      font-weight: 600;
      color: #f1f5f9;
      margin: 0 0 16px 0;
    }

    .command-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    .command-button {
      padding: 12px 16px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      color: #60a5fa;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: left;
    }

    .command-button:hover {
      background: rgba(59, 130, 246, 0.2);
      border-color: rgba(59, 130, 246, 0.5);
      transform: translateY(-1px);
    }

    .footer-info {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid rgba(148, 163, 184, 0.2);
      text-align: center;
      font-size: 13px;
      color: #64748b;
    }
  `;

  render() {
    return html`
      <div class="mission-container">
        <div class="mission-header">
          <div>
            <h1 class="mission-title">Mission Control</h1>
            <div class="mission-subtitle">OpenClaw Command Center</div>
          </div>
          <div class="status-indicator">
            <div class="status-dot ${this.systemStatus}"></div>
            <span class="status-text">${this.systemStatus}</span>
          </div>
        </div>

        <div class="mission-grid">
          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">Active Workflows</h3>
              <span class="card-badge">LIVE</span>
            </div>
            <div class="card-metric">${this.activeWorkflows}</div>
            <div class="card-label">Running Processes</div>
          </div>

          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">Completed Tasks</h3>
              <span class="card-badge">24H</span>
            </div>
            <div class="card-metric">${this.completedTasks}</div>
            <div class="card-label">Last 24 Hours</div>
          </div>

          <div class="mission-card">
            <div class="card-header">
              <h3 class="card-title">System Uptime</h3>
              <span class="card-badge">STATUS</span>
            </div>
            <div class="card-metric">${this.uptime}</div>
            <div class="card-label">Availability</div>
          </div>
        </div>

        <div class="mission-card">
          <div class="card-header">
            <h3 class="card-title">Active Operations</h3>
          </div>
          <ul class="workflow-list">
            <li class="workflow-item">
              <span class="workflow-name">Data Processing Pipeline</span>
              <span class="workflow-status">RUNNING</span>
            </li>
            <li class="workflow-item">
              <span class="workflow-name">Model Training Sequence</span>
              <span class="workflow-status">RUNNING</span>
            </li>
            <li class="workflow-item">
              <span class="workflow-name">System Health Monitor</span>
              <span class="workflow-status">RUNNING</span>
            </li>
          </ul>
        </div>

        <div class="command-panel">
          <h2 class="command-title">Quick Commands</h2>
          <div class="command-grid">
            <button class="command-button">Deploy Workflow</button>
            <button class="command-button">View Logs</button>
            <button class="command-button">System Diagnostics</button>
            <button class="command-button">Resource Monitor</button>
            <button class="command-button">Task Queue</button>
            <button class="command-button">Configuration</button>
          </div>
        </div>

        <div class="footer-info">
          Mission Control Interface • OpenClaw Usage Mode
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "mission-view": MissionView;
  }
}

import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";

/**
 * Star usage-mode view
 * Inspired by Star-Office/personal workspace aesthetics:
 * - Spatial, atmospheric layout
 * - Human/agent presence indicators
 * - Warmth and inhabitable character
 * - Personal workspace feeling
 */
@customElement("star-view")
export class StarView extends LitElement {
  @state() private agentPresence: "active" | "idle" | "away" = "active";
  @state() private recentActivity: string[] = [
    "Completed code review",
    "Updated documentation",
    "Deployed to staging"
  ];
  @state() private currentTime: string = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  });

  connectedCallback() {
    super.connectedCallback();
    // Update time every minute
    setInterval(() => {
      this.currentTime = new Date().toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    }, 60000);
  }

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: radial-gradient(ellipse at top, #1a1f3a 0%, #0d1117 50%, #050810 100%);
      color: #e6edf3;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
      overflow: auto;
      position: relative;
    }

    /* Atmospheric background elements */
    .star-background {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 0;
    }

    .ambient-glow {
      position: absolute;
      width: 600px;
      height: 600px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(139, 92, 246, 0.08) 0%, transparent 70%);
      top: -200px;
      right: -200px;
      animation: float 20s ease-in-out infinite;
    }

    .ambient-glow-2 {
      position: absolute;
      width: 400px;
      height: 400px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.06) 0%, transparent 70%);
      bottom: -100px;
      left: -100px;
      animation: float 15s ease-in-out infinite reverse;
    }

    @keyframes float {
      0%, 100% { transform: translate(0, 0); }
      50% { transform: translate(30px, -30px); }
    }

    .star-container {
      position: relative;
      z-index: 1;
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 32px;
      min-height: 100vh;
    }

    .star-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 48px;
    }

    .welcome-section {
      flex: 1;
    }

    .greeting {
      font-size: 32px;
      font-weight: 300;
      color: #c9d1d9;
      margin: 0 0 8px 0;
      letter-spacing: -0.01em;
    }

    .workspace-name {
      font-size: 18px;
      color: #8b949e;
      font-weight: 400;
      margin: 0;
    }

    .time-presence {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 12px;
    }

    .current-time {
      font-size: 48px;
      font-weight: 200;
      color: #e6edf3;
      letter-spacing: -0.02em;
      line-height: 1;
    }

    .presence-indicator {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: rgba(139, 92, 246, 0.1);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 20px;
    }

    .presence-avatar {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      position: relative;
    }

    .presence-status {
      position: absolute;
      bottom: -2px;
      right: -2px;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #10b981;
      border: 2px solid #0d1117;
    }

    .presence-status.idle {
      background: #f59e0b;
    }

    .presence-status.away {
      background: #6b7280;
    }

    .presence-label {
      font-size: 14px;
      color: #a78bfa;
      font-weight: 500;
    }

    .workspace-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 32px;
    }

    @media (max-width: 900px) {
      .workspace-grid {
        grid-template-columns: 1fr;
      }
    }

    .workspace-panel {
      background: rgba(22, 27, 34, 0.6);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(110, 118, 129, 0.2);
      border-radius: 16px;
      padding: 28px;
      transition: all 0.3s ease;
    }

    .workspace-panel:hover {
      background: rgba(22, 27, 34, 0.8);
      border-color: rgba(139, 92, 246, 0.3);
      transform: translateY(-4px);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .panel-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: linear-gradient(135deg, rgba(139, 92, 246, 0.2) 0%, rgba(99, 102, 241, 0.2) 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
    }

    .panel-title {
      font-size: 18px;
      font-weight: 500;
      color: #e6edf3;
      margin: 0;
    }

    .activity-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .activity-item {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 0;
      border-bottom: 1px solid rgba(110, 118, 129, 0.1);
    }

    .activity-item:last-child {
      border-bottom: none;
    }

    .activity-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #8b5cf6;
      flex-shrink: 0;
    }

    .activity-text {
      font-size: 14px;
      color: #c9d1d9;
      line-height: 1.5;
    }

    .quick-actions {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .action-button {
      padding: 16px;
      background: rgba(139, 92, 246, 0.08);
      border: 1px solid rgba(139, 92, 246, 0.2);
      border-radius: 12px;
      color: #a78bfa;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.2s ease;
      text-align: center;
    }

    .action-button:hover {
      background: rgba(139, 92, 246, 0.15);
      border-color: rgba(139, 92, 246, 0.4);
      transform: scale(1.02);
    }

    .workspace-stats {
      display: flex;
      gap: 24px;
      margin-top: 16px;
    }

    .stat-item {
      flex: 1;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: #8b5cf6;
      margin-bottom: 4px;
    }

    .stat-label {
      font-size: 12px;
      color: #8b949e;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .ambient-message {
      text-align: center;
      padding: 32px;
      margin-top: 32px;
      background: rgba(139, 92, 246, 0.05);
      border: 1px solid rgba(139, 92, 246, 0.1);
      border-radius: 16px;
    }

    .ambient-text {
      font-size: 16px;
      color: #8b949e;
      font-weight: 300;
      line-height: 1.6;
      font-style: italic;
    }

    .workspace-footer {
      margin-top: 48px;
      padding-top: 24px;
      border-top: 1px solid rgba(110, 118, 129, 0.1);
      text-align: center;
      font-size: 13px;
      color: #6e7681;
    }
  `;

  render() {
    return html`
      <div class="star-background">
        <div class="ambient-glow"></div>
        <div class="ambient-glow-2"></div>
      </div>

      <div class="star-container">
        <div class="star-header">
          <div class="welcome-section">
            <h1 class="greeting">Welcome back</h1>
            <p class="workspace-name">Your OpenClaw Workspace</p>
          </div>
          <div class="time-presence">
            <div class="current-time">${this.currentTime}</div>
            <div class="presence-indicator">
              <div class="presence-avatar">
                <div class="presence-status ${this.agentPresence}"></div>
              </div>
              <span class="presence-label">Agent ${this.agentPresence}</span>
            </div>
          </div>
        </div>

        <div class="workspace-grid">
          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">✨</div>
              <h2 class="panel-title">Recent Activity</h2>
            </div>
            <ul class="activity-list">
              ${this.recentActivity.map(activity => html`
                <li class="activity-item">
                  <div class="activity-dot"></div>
                  <span class="activity-text">${activity}</span>
                </li>
              `)}
            </ul>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">🚀</div>
              <h2 class="panel-title">Quick Actions</h2>
            </div>
            <div class="quick-actions">
              <button class="action-button">Start Session</button>
              <button class="action-button">Review Tasks</button>
              <button class="action-button">Check Status</button>
              <button class="action-button">View Logs</button>
            </div>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">📊</div>
              <h2 class="panel-title">Workspace Stats</h2>
            </div>
            <div class="workspace-stats">
              <div class="stat-item">
                <div class="stat-value">24</div>
                <div class="stat-label">Sessions</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">156</div>
                <div class="stat-label">Tasks</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">98%</div>
                <div class="stat-label">Success</div>
              </div>
            </div>
          </div>

          <div class="workspace-panel">
            <div class="panel-header">
              <div class="panel-icon">💬</div>
              <h2 class="panel-title">Agent Notes</h2>
            </div>
            <ul class="activity-list">
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">Ready to assist with your next task</span>
              </li>
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">All systems running smoothly</span>
              </li>
              <li class="activity-item">
                <div class="activity-dot"></div>
                <span class="activity-text">Workspace preferences saved</span>
              </li>
            </ul>
          </div>
        </div>

        <div class="ambient-message">
          <p class="ambient-text">
            Your workspace is ready. Take a moment to settle in, then let's create something together.
          </p>
        </div>

        <div class="workspace-footer">
          OpenClaw Star Workspace · Designed for human-agent collaboration
        </div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "star-view": StarView;
  }
}

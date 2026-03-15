import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { UsageVariant } from "../core/types";

@customElement("use-mode-view")
export class UseModeView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: linear-gradient(180deg, #08111f 0%, #0e1a2b 100%);
      padding: 32px;
      box-sizing: border-box;
      font-family: Inter, "Segoe UI", sans-serif;
      color: #e5eef7;
    }

    .container {
      max-width: 1180px;
      margin: 0 auto;
      padding-top: 60px;
    }

    .hero {
      background: rgba(16, 24, 40, 0.78);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 20px;
      padding: 48px;
      backdrop-filter: blur(12px);
      box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
      text-align: center;
    }

    h1 {
      margin: 0 0 16px;
      font-size: 48px;
      line-height: 1.2;
      background: linear-gradient(135deg, #93c5fd, #3b82f6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    p {
      margin: 0;
      color: #cbd5e1;
      font-size: 18px;
      line-height: 1.7;
    }

    .variant-label {
      display: inline-block;
      margin-top: 24px;
      padding: 8px 16px;
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.3);
      border-radius: 8px;
      color: #93c5fd;
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
  `;

  @property() variant: UsageVariant = "native";

  render() {
    return html`
      <div class="container">
        <div class="hero">
          <h1>OpenClaw Client</h1>
          <p>Chat-driven front-end co-creation workspace</p>
          <div class="variant-label">Variant: ${this.variant}</div>
          <p style="margin-top: 32px; font-size: 15px; color: #94a3b8;">
            This is the USE mode surface. Variant-specific UI will be implemented here.
          </p>
        </div>
      </div>
    `;
  }
}

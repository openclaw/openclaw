import { LitElement, css, html } from "lit";
import { customElement, state } from "lit/decorators.js";

@customElement("usage-mode-blank")
export class UsageModeBlank extends LitElement {
  @state() private greeting = this.getGreeting();

  private getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      background: #fafafa;
      color: #1a1a1a;
      font-family: Inter, "Segoe UI", system-ui, sans-serif;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
      padding: 80px 32px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 48px;
      min-height: 100vh;
      box-sizing: border-box;
    }

    .greeting {
      font-size: 32px;
      font-weight: 300;
      color: #404040;
      letter-spacing: -0.02em;
      text-align: center;
    }

    .main-area {
      width: 100%;
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 32px;
    }

    .prompt-area {
      width: 100%;
      max-width: 600px;
      min-height: 120px;
      padding: 20px;
      background: #ffffff;
      border: 1px solid #e5e5e5;
      border-radius: 12px;
      font-size: 15px;
      color: #737373;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      line-height: 1.6;
      transition: border-color 0.2s ease;
    }

    .prompt-area:hover {
      border-color: #d4d4d4;
    }

    .hint {
      font-size: 13px;
      color: #a3a3a3;
      text-align: center;
      max-width: 400px;
    }

    .footer {
      margin-top: auto;
      padding-top: 40px;
      font-size: 12px;
      color: #d4d4d4;
      text-align: center;
    }

    @media (max-width: 768px) {
      .container {
        padding: 60px 24px;
        gap: 36px;
      }

      .greeting {
        font-size: 28px;
      }

      .prompt-area {
        min-height: 100px;
        font-size: 14px;
      }
    }
  `;

  render() {
    return html`
      <div class="container">
        <div class="greeting">${this.greeting}</div>

        <div class="main-area">
          <div class="prompt-area">
            Start with a blank canvas
          </div>

          <div class="hint">
            A quiet space to begin
          </div>
        </div>

        <div class="footer">
          Blank
        </div>
      </div>
    `;
  }
}

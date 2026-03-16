import { LitElement, html, css } from "lit";
import { customElement, state } from "lit/decorators.js";
import { AppState } from "./app-state";
import type { AppMode, UsageVariant } from "./types";
import { type Language, getTranslation, detectBrowserLanguage } from "./i18n";
import { loadLanguagePreference } from "../product/storage";

@customElement("app-shell")
export class AppShell extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }

    .floating-bar {
      position: fixed;
      z-index: 1000;
      display: flex;
      gap: 8px;
      background: rgba(16, 24, 40, 0.95);
      border: 1px solid rgba(148, 163, 184, 0.18);
      border-radius: 12px;
      padding: 8px;
      backdrop-filter: blur(12px);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.22);
    }

    .mode-switcher {
      top: 16px;
      right: 16px;
    }

    .variant-switcher {
      top: 16px;
      left: 16px;
      flex-wrap: wrap;
      max-width: min(560px, calc(100vw - 140px));
    }

    button {
      border: 0;
      border-radius: 8px;
      padding: 8px 14px;
      background: rgba(51, 65, 85, 0.9);
      color: #e5eef7;
      font: inherit;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    button.active {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
    }

    button:hover:not(.active) {
      background: rgba(71, 85, 105, 0.9);
    }

    .bar-label {
      display: inline-flex;
      align-items: center;
      padding: 0 8px;
      color: #93c5fd;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }

    @media (max-width: 760px) {
      .mode-switcher {
        right: 12px;
        top: 12px;
      }

      .variant-switcher {
        left: 12px;
        top: 72px;
        max-width: calc(100vw - 24px);
      }
    }
  `;

  private appState = AppState.getInstance();
  private unsubscribe?: () => void;

  @state() private mode: AppMode = "use";
  @state() private variant: UsageVariant = "native";
  @state() private language: Language = "zh";

  connectedCallback(): void {
    super.connectedCallback();
    this.language = loadLanguagePreference() ?? detectBrowserLanguage();
    this.mode = this.appState.mode;
    this.variant = this.appState.variant;
    this.unsubscribe = this.appState.subscribe(() => {
      this.mode = this.appState.mode;
      this.variant = this.appState.variant;
    });
  }

  disconnectedCallback(): void {
    this.unsubscribe?.();
    super.disconnectedCallback();
  }

  private switchMode(mode: AppMode): void {
    this.appState.setMode(mode);
  }

  private switchVariant(variant: UsageVariant): void {
    this.appState.setVariant(variant);
  }

  private t(key: Parameters<typeof getTranslation>[1]): string {
    return getTranslation(this.language, key);
  }

  private renderVariantButton(variant: UsageVariant, label: string) {
    return html`
      <button
        class=${this.variant === variant ? "active" : ""}
        @click=${() => this.switchVariant(variant)}
      >
        ${label}
      </button>
    `;
  }

  render() {
    return html`
      <div class="floating-bar mode-switcher">
        <button
          class=${this.mode === "use" ? "active" : ""}
          @click=${() => this.switchMode("use")}
        >
          ${this.t("modeUse")}
        </button>
        <button
          class=${this.mode === "control" ? "active" : ""}
          @click=${() => this.switchMode("control")}
        >
          ${this.t("modeControl")}
        </button>
      </div>

      <div class="floating-bar variant-switcher">
        <span class="bar-label">${this.t("usageLabel")}</span>
        ${this.renderVariantButton("native", "Native")}
        ${this.renderVariantButton("mission", "Mission")}
        ${this.renderVariantButton("star", "Star")}
        ${this.renderVariantButton("blank", "Blank")}
      </div>

      ${this.mode === "use"
        ? html`<use-mode-view .variant=${this.variant}></use-mode-view>`
        : html`<control-mode-view></control-mode-view>`}
    `;
  }
}

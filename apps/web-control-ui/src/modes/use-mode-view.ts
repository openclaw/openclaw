import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { UsageVariant } from "../core/types";
import "../usage-modes/native";
import "../usage-modes/blank";
import "../views/mission-view";
import "../views/star-view";

@customElement("use-mode-view")
export class UseModeView extends LitElement {
  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
    }
  `;

  @property() variant: UsageVariant = "native";

  render() {
    switch (this.variant) {
      case "mission":
        return html`<mission-view></mission-view>`;
      case "star":
        return html`<star-view></star-view>`;
      case "blank":
        return html`<usage-mode-blank></usage-mode-blank>`;
      case "native":
      default:
        return html`<usage-mode-native></usage-mode-native>`;
    }
  }
}

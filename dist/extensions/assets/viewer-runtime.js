const DIFFS_TAG_NAME = "diffs-container";

if (typeof HTMLElement !== "undefined" && customElements.get(DIFFS_TAG_NAME) == null) {
  class DiffsContainerElement extends HTMLElement {
    constructor() {
      super();
      if (this.shadowRoot != null) return;

      const template = this.querySelector(':scope > template[shadowrootmode="open"]');
      if (!(template instanceof HTMLTemplateElement)) return;

      const shadowRoot = this.attachShadow({ mode: "open" });
      shadowRoot.append(template.content.cloneNode(true));
      template.remove();
    }
  }

  customElements.define(DIFFS_TAG_NAME, DiffsContainerElement);
}

document.documentElement.dataset.openclawDiffsReady = "true";

export const DiffsContainerLoaded = true;

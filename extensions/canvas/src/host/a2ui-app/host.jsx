import { render } from "@solidjs/web";

// The document contract creates this tag before loading the renderer script.
// This native adapter owns only connection/disposal; Solid owns its children.
export function defineHost(Model, App) {
  class A2UIHost extends HTMLElement {
    #model = new Model();
    #dispose;
    #disconnect;
    #api;

    connectedCallback() {
      this.#disconnect = this.#model.connect(this);
      this.#api = {
        applyMessages: (messages) => this.#model.applyMessages(messages),
        reset: () => this.#model.reset(),
        getSurfaces: () => this.#model.getSurfaces(),
      };
      globalThis.openclawA2UI = this.#api;
      const messages = globalThis.openclawA2UIBoot?.messages;
      if (Array.isArray(messages)) {
        this.#model.applyMessages(messages);
      }
      this.#dispose = render(() => <App model={this.#model} />, this);
    }

    disconnectedCallback() {
      this.#dispose?.();
      this.#dispose = undefined;
      this.#disconnect?.();
      this.#disconnect = undefined;
      if (globalThis.openclawA2UI === this.#api) {
        delete globalThis.openclawA2UI;
      }
    }
  }
  if (!customElements.get("openclaw-a2ui-host")) {
    customElements.define("openclaw-a2ui-host", A2UIHost);
  }
}

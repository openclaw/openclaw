import {
  ComponentContext,
  MessageProcessor,
  NodeResolver,
  effect,
  getValue,
} from "@a2ui/web_core/v0_9";
import { basicCatalog } from "@a2ui/web_core/v0_9/basic_catalog";
import { registerUniversalElement } from "@a2ui/web_core/v0_9/universal";
import { For, Show, createSignal, onCleanup, untrack } from "solid-js";
import { defineHost } from "./host.jsx";

const actionText = (action) => {
  const context =
    action?.context && Object.keys(action.context).length ? action.context : undefined;
  return context
    ? `A2UI action ${action.name}: ${JSON.stringify(context)}`
    : `A2UI action ${action?.name ?? "selected"}`;
};

class A2UIModel {
  #processor = this.#createProcessor();
  error = "";
  notify = () => {};

  #createProcessor() {
    const processor = new MessageProcessor([basicCatalog], async (action) => {
      try {
        const api = globalThis.openclaw;
        if (!api?.state?.emit) {
          throw new Error("missing board action bridge");
        }
        if (globalThis.openclawA2UIBoot?.actionTier === "prompt" && api.prompt?.send) {
          await api.prompt.send(actionText(action));
        } else {
          await api.state.emit({ eventType: "a2ui.action", action });
        }
      } catch (error) {
        if (processor !== this.#processor) {
          return;
        }
        this.error = String(error?.message ?? error);
        this.notify();
      }
    });
    return processor;
  }

  connect() {
    return () => {};
  }
  get surfaces() {
    return Array.from(this.#processor.model.surfacesMap.entries());
  }
  getSurfaces() {
    return this.surfaces.map(([id]) => id);
  }

  applyMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error("A2UI: expected messages array");
    }
    this.#processor.processMessages(messages);
    this.notify();
    return { ok: true, surfaces: this.getSurfaces() };
  }

  reset() {
    this.#processor.model.dispose();
    this.#processor = this.#createProcessor();
    this.error = "";
    this.notify();
    return { ok: true };
  }
}

function CatalogRoot(props) {
  // The resolver replaces the keyed root when its identity or type changes.
  const node = untrack(() => props.node);
  const surface = untrack(() => props.surface);
  const implementation = node.impl;
  registerUniversalElement(implementation);
  const element = document.createElement(implementation.tagName);
  element.context = new ComponentContext(surface, node.componentId, node.dataPath);
  return element;
}

function Surface(props) {
  // The parent keys each surface by the processor-owned model identity.
  const surface = untrack(() => props.surface);
  const resolver = new NodeResolver(surface, surface.defaultCatalog);
  const [root, setRoot] = createSignal();
  const stop = effect(() => setRoot(getValue(resolver.rootNode)));
  onCleanup(() => {
    stop();
    resolver.dispose();
  });
  return (
    <a2ui-surface>
      <Show when={root()} keyed fallback={<div>Loading surface...</div>}>
        {(node) => (
          <Show
            when={node.impl}
            fallback={<div role="alert">Unknown component type: {node.type}</div>}
          >
            <CatalogRoot node={node} surface={surface} />
          </Show>
        )}
      </Show>
    </a2ui-surface>
  );
}

function A2UIApp(props) {
  const model = untrack(() => props.model);
  const [revision, setRevision] = createSignal(0);
  model.notify = () => setRevision((value) => value + 1);
  onCleanup(() => {
    model.notify = () => {};
  });
  const read = () => {
    revision();
    return model;
  };
  return (
    <>
      <style>{`
      openclaw-a2ui-host { display: block; min-height: 100%; color: var(--text); background: transparent; }
      openclaw-a2ui-host #surfaces { display: grid; gap: 12px; min-height: 100%; }
      openclaw-a2ui-host .error { color: var(--danger); padding: 12px; }
    `}</style>
      <Show when={read().error}>
        {(error) => (
          <div class="error" role="alert">
            {error()}
          </div>
        )}
      </Show>
      <section id="surfaces">
        <For each={read().surfaces} keyed={(entry) => entry[1]}>
          {(entry) => <Surface surface={entry()[1]} />}
        </For>
      </section>
    </>
  );
}

defineHost(A2UIModel, A2UIApp);

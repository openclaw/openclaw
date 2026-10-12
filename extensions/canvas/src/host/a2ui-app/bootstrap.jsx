import { A2uiMessageProcessor } from "@a2ui/web_core/v0_8";
import { SignalArray } from "signal-utils/array";
import { SignalMap } from "signal-utils/map";
import { SignalObject } from "signal-utils/object";
import { SignalSet } from "signal-utils/set";
import { For, Show, createSignal, onCleanup, untrack } from "solid-js";
import { hostStyles } from "./host-styles.js";
import { defineHost } from "./host.jsx";
import { provideTheme } from "./theme.js";

const createSecureActionId = () => {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues === "function") {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return `a2ui_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
};

class A2UIModel {
  #processor = new A2uiMessageProcessor({
    arrayCtor: SignalArray,
    mapCtor: SignalMap,
    objCtor: SignalObject,
    setCtor: SignalSet,
  });
  surfaces = [];
  pendingAction = null;
  toast = null;
  notify = () => {};
  #toastTimer;
  #actionListener = (event) => this.#handleA2UIAction(event);
  #statusListener = (event) => this.#handleActionStatus(event);

  connect(host) {
    host.addEventListener("a2uiaction", this.#actionListener);
    globalThis.addEventListener("openclaw:a2ui-action-status", this.#statusListener);
    const stopTheme = provideTheme(host);
    return () => {
      host.removeEventListener("a2uiaction", this.#actionListener);
      globalThis.removeEventListener("openclaw:a2ui-action-status", this.#statusListener);
      clearTimeout(this.#toastTimer);
      this.toast = null;
      stopTheme();
    };
  }

  get processor() {
    return this.#processor;
  }

  getSurfaces() {
    return Array.from(this.#processor.getSurfaces().keys());
  }

  #setToast(text, kind = "ok", timeoutMs = 1400) {
    const toast = { text, kind, expiresAt: Date.now() + timeoutMs };
    this.toast = toast;
    this.notify();
    clearTimeout(this.#toastTimer);
    this.#toastTimer = setTimeout(() => {
      if (this.toast === toast) {
        this.toast = null;
        this.notify();
      }
    }, timeoutMs + 30);
  }

  #handleActionStatus(evt) {
    const detail = evt?.detail ?? null;
    if (!detail || typeof detail.id !== "string") {
      return;
    }
    if (!this.pendingAction || this.pendingAction.id !== detail.id) {
      return;
    }

    if (detail.ok) {
      this.pendingAction = { ...this.pendingAction, phase: "sent", sentAt: Date.now() };
    } else {
      const msg = typeof detail.error === "string" && detail.error ? detail.error : "send failed";
      this.pendingAction = { ...this.pendingAction, phase: "error", error: msg };
      this.#setToast(`Failed: ${msg}`, "error", 4500);
    }
    this.notify();
  }

  #handleA2UIAction(evt) {
    const payload = evt?.detail ?? evt?.payload ?? null;
    if (!payload || payload.eventType !== "a2ui.action") {
      return;
    }

    const action = payload.action;
    const name = action?.name;
    if (!name) {
      return;
    }

    const sourceComponentId = payload.sourceComponentId ?? "";
    const surfaces = this.#processor.getSurfaces();

    let surfaceId = null;
    let sourceNode = null;
    for (const [sid, surface] of surfaces.entries()) {
      const node = surface?.components?.get?.(sourceComponentId) ?? null;
      if (node) {
        surfaceId = sid;
        sourceNode = node;
        break;
      }
    }

    const context = {};
    const ctxItems = Array.isArray(action?.context) ? action.context : [];
    for (const item of ctxItems) {
      const key = item?.key;
      const value = item?.value ?? null;
      if (!key || !value) {
        continue;
      }

      if (typeof value.path === "string") {
        const resolved = sourceNode
          ? this.#processor.getData(sourceNode, value.path, surfaceId ?? undefined)
          : null;
        context[key] = resolved;
        continue;
      }
      if (Object.hasOwn(value, "literalString")) {
        context[key] = value.literalString ?? "";
        continue;
      }
      if (Object.hasOwn(value, "literalNumber")) {
        context[key] = value.literalNumber ?? 0;
        continue;
      }
      if (Object.hasOwn(value, "literalBoolean")) {
        context[key] = value.literalBoolean ?? false;
        continue;
      }
    }

    const actionId = createSecureActionId();
    if (!actionId) {
      this.#setToast("Secure action identifiers unavailable", "error", 4500);
      return;
    }
    this.pendingAction = { id: actionId, name, phase: "sending", startedAt: Date.now() };
    this.notify();

    const userAction = {
      id: actionId,
      name,
      surfaceId: surfaceId ?? "main",
      sourceComponentId,
      timestamp: new Date().toISOString(),
      ...(Object.keys(context).length ? { context } : {}),
    };

    globalThis["__openclawLastA2UIAction"] = userAction;

    const boardApi = globalThis.openclaw;
    if (boardApi?.state?.emit) {
      const request =
        globalThis.openclawA2UIBoot?.actionTier === "prompt" && boardApi.prompt?.send
          ? boardApi.prompt.send(
              Object.keys(context).length
                ? `A2UI action ${name}: ${JSON.stringify(context)}`
                : `A2UI action ${name}`,
            )
          : boardApi.state.emit({ eventType: "a2ui.action", action: userAction });
      void Promise.resolve(request).then(
        () => this.#handleActionStatus({ detail: { id: actionId, ok: true } }),
        (/** @type {unknown} */ error) =>
          this.#handleActionStatus({
            detail: { id: actionId, ok: false, error: String(error?.message ?? error) },
          }),
      );
      return;
    }

    this.pendingAction = {
      id: actionId,
      name,
      phase: "error",
      startedAt: Date.now(),
      error: "missing board action bridge",
    };
    this.#setToast("Failed: missing board action bridge", "error", 4500);
  }

  applyMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new Error("A2UI: expected messages array");
    }
    this.#processor.processMessages(messages);
    this.#syncSurfaces();
    if (this.pendingAction?.phase === "sent") {
      this.#setToast(`Updated: ${this.pendingAction.name}`, "ok", 1100);
      this.pendingAction = null;
    }
    this.notify();
    return { ok: true, surfaces: this.surfaces.map(([id]) => id) };
  }

  reset() {
    this.#processor.clearSurfaces();
    this.#syncSurfaces();
    this.pendingAction = null;
    this.notify();
    return { ok: true };
  }

  #syncSurfaces() {
    this.surfaces = Array.from(this.#processor.getSurfaces().entries());
  }
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
  const statusText = () => {
    const action = read().pendingAction;
    return action ? `${action.phase === "sent" ? "Working" : "Sending"}: ${action.name}` : "";
  };
  return (
    <>
      <style>{hostStyles}</style>
      <Show
        when={read().surfaces.length > 0}
        fallback={
          <div class="empty">
            <div class="empty-title">Canvas (A2UI)</div>
          </div>
        }
      >
        <Show when={read().pendingAction && read().pendingAction.phase !== "error"}>
          <div class="status">
            <div class="spinner" />
            <div>{statusText()}</div>
          </div>
        </Show>
        <Show when={read().toast}>
          {(toast) => (
            <div class={["toast", { error: toast().kind === "error" }]}>{toast().text}</div>
          )}
        </Show>
        <section id="surfaces">
          <For each={read().surfaces} keyed={(entry) => entry[0]}>
            {(entry) => (
              <a2ui-surface
                prop:surfaceId={entry()[0]}
                prop:surface={entry()[1]}
                prop:processor={model.processor}
              />
            )}
          </For>
        </section>
      </Show>
    </>
  );
}

defineHost(A2UIModel, A2UIApp);

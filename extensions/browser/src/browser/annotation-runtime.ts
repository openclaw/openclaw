/**
 * Runs in the page main world. Keep this source literal: function.toString() is
 * not a transport contract after production minification and name preservation.
 * The page owns callbacks/data; this closure owns only the current document's
 * selection. It has no Gateway, credentials, or chat-delivery capability.
 */
export const browserAnnotationRuntimeSource = String.raw`(() => {
  if (Object.hasOwn(document, "__openclawAnnotationHost")) return;
  const documentId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const surfaces = new Map();
  const controls = new Map();
  let nextId = 0;
  let active = false;
  let selection = null;
  let pending = null;
  const color = /^#[\da-f]{6}$/i;
  const text = (value, max) => typeof value === "string" ? value.slice(0, max) : "";
  const connected = (element) => element instanceof Element && element.ownerDocument === document && element.isConnected;
  const metadata = (value) => {
    try {
      const json = JSON.stringify(value);
      return json && json.length <= 4096 ? JSON.parse(json) : undefined;
    } catch { return undefined; }
  };
  const rect = (value) => value && [value.x, value.y, value.width, value.height].every(Number.isFinite)
    && value.width >= 0 && value.height >= 0
    ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
  const render = (surface, selectedId) => {
    try { surface.renderSelection({ selectedId, hoveredId: null }); } catch { /* Page callbacks cannot prevent cleanup. */ }
  };
  const cancel = () => {
    const current = pending;
    pending = null;
    current?.abort();
  };
  const clear = () => {
    cancel();
    const old = selection;
    selection = null;
    if (old) {
      const surface = surfaces.get(old.surfaceId);
      if (surface) render(surface, null);
    }
  };
  const setActive = (next) => {
    if (!next) clear();
    if (active !== next) {
      active = next;
      document.dispatchEvent(new CustomEvent("openclawannotationmodechange", { detail: { active } }));
    }
  };
  const readControls = (value) => Array.isArray(value) ? value.filter((entry) =>
    entry?.type === "color" && typeof entry.callback === "string" && entry.callback.length > 0
    && entry.callback.length <= 80 && typeof entry.currentValue === "string" && color.test(entry.currentValue)
  ).slice(0, 4).map((entry) => ({ type: "color", callback: entry.callback,
    currentValue: entry.currentValue, ...(typeof entry.label === "string" ? { label: text(entry.label, 128) } : {}) })) : [];
  const state = () => {
    for (const [id, surface] of surfaces) {
      if (!connected(surface.element)) {
        cancel();
        if (selection?.surfaceId === id) clear();
        surfaces.delete(id);
        controls.delete(surface.element);
      }
    }
    if (selection && !connected(selection.element)) clear();
    const registered = selection ? controls.get(selection.element) : null;
    return {
      documentId, active, surfaceCount: surfaces.size,
      selection: selection ? { ...selection.target, surfaceId: selection.surfaceId } : null,
      controls: registered ? readControls(registered.controls) : [],
      controlsHeading: text(registered?.controlsHeading, 256),
    };
  };
  const api = {
    version: 1,
    registerSurface(options) {
      if (!connected(options?.element) || typeof options.hitTest !== "function" || typeof options.renderSelection !== "function") {
        throw new TypeError("An annotation surface requires a connected element and callbacks.");
      }
      if (surfaces.size >= 128) throw new Error("Too many annotation surfaces.");
      const id = "surface-" + ++nextId;
      const surface = { element: options.element, hitTest: options.hitTest, renderSelection: options.renderSelection };
      surfaces.set(id, surface);
      return {
        invalidate() {
          if (surfaces.get(id) !== surface) return;
          cancel();
          if (selection?.surfaceId === id) clear();
        },
        dispose() {
          if (surfaces.get(id) !== surface) return;
          cancel();
          if (selection?.surfaceId === id) clear();
          surfaces.delete(id);
        },
      };
    },
    registerControls(options) {
      const element = options?.targets;
      if (!connected(element)) throw new TypeError("Annotation controls require a connected element.");
      if (controls.size >= 128 && !controls.has(element)) throw new Error("Too many annotation controls.");
      const registered = { controls: readControls(options.controls), controlsHeading: text(options.controlsHeading, 256) };
      controls.set(element, registered);
      return {
        update(next) {
          if (controls.get(element) !== registered) return;
          if (next.controls !== undefined) registered.controls = readControls(next.controls);
          if (next.controlsHeading !== undefined) registered.controlsHeading = text(next.controlsHeading, 256);
        },
        dispose() { if (controls.get(element) === registered) controls.delete(element); },
      };
    },
    toggle(next) {
      if (typeof next !== "boolean" || (next && !navigator.userActivation?.isActive)) return { accepted: false };
      setActive(next);
      return { accepted: true };
    },
    isActive() { return active; },
    request(element, options = {}) {
      if (!connected(element) || (options.enterAnnotationMode !== false && !api.toggle(true).accepted)) return { accepted: false };
      const bounds = rect(element.getBoundingClientRect());
      if (!bounds) return { accepted: false };
      clear();
      const id = "request-" + ++nextId;
      selection = { surfaceId: id, element, target: {
        id, name: text(element.getAttribute("aria-label") || element.tagName.toLowerCase(), 160),
        rect: bounds, metadata: metadata(options.metadata),
      } };
      return { accepted: true };
    },
  };
  const dispatch = async (command) => {
    if (command.action === "state") return state();
    if (command.documentId !== documentId) throw new Error("Annotation document changed. Refresh the browser panel.");
    if (command.action === "stop") { setActive(false); return state(); }
    if (!active) throw new Error("Annotation mode is not active.");
    if (command.action === "control") {
      state();
      const selected = selection;
      const registered = selected ? controls.get(selected.element) : null;
      if (!selected || selected.surfaceId !== command.virtualTarget.surfaceId || selected.target.id !== command.virtualTarget.targetId
        || !registered || !readControls(registered.controls).some((entry) => entry.callback === command.callback)
        || !color.test(command.value)) throw new Error("Annotation selection or control changed.");
      selected.element.dispatchEvent(new CustomEvent("openclawannotationcontrolchange", { detail: {
        action: command.change, callback: command.callback, value: command.value,
        virtualTarget: { surfaceId: selected.surfaceId, targetId: selected.target.id },
      } }));
      return state();
    }
    if (command.action !== "select" || !Number.isFinite(command.clientX) || !Number.isFinite(command.clientY)) {
      throw new TypeError("Invalid annotation command.");
    }
    clear();
    state();
    const controller = new AbortController();
    pending = controller;
    const signal = controller.signal;
    // A plugin's unresolved promise must not hold the host request indefinitely.
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const hit = document.elementFromPoint(command.clientX, command.clientY);
      for (const [id, surface] of [...surfaces].reverse()) {
        if (!hit || !(surface.element === hit || surface.element.contains(hit))) continue;
        const bounds = surface.element.getBoundingClientRect();
        if (command.clientX < bounds.left || command.clientY < bounds.top || command.clientX > bounds.right || command.clientY > bounds.bottom) continue;
        const found = surface.hitTest({ clientX: command.clientX, clientY: command.clientY, signal });
        if (signal.aborted) return state();
        const target = await Promise.race([
          Promise.resolve(found),
          new Promise((resolve) => signal.addEventListener("abort", () => resolve(null), { once: true })),
        ]);
        if (signal.aborted || pending !== controller || !active || surfaces.get(id) !== surface || !connected(surface.element)) return state();
        if (!target) continue;
        const targetRect = rect(target.rect);
        if (typeof target.id !== "string" || !target.id || target.id.length > 512 || !targetRect) continue;
        selection = { surfaceId: id, element: surface.element, target: {
          id: target.id, name: text(target.name, 160), rect: targetRect,
          ...(typeof target.role === "string" ? { role: text(target.role, 128) } : {}),
          metadata: metadata(target.metadata),
        } };
        render(surface, target.id);
        break;
      }
      return state();
    } catch {
      if (pending === controller) clear();
      return state();
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  };
  const namespace = document.openclaw ?? {};
  if (namespace.annotation !== undefined) throw new Error("The page already defines an incompatible OpenClaw annotation API.");
  Object.defineProperty(namespace, "annotation", { value: api, enumerable: true });
  if (!document.openclaw) Object.defineProperty(document, "openclaw", { value: namespace });
  Object.defineProperty(document, "__openclawAnnotationHost", { value: dispatch });
  window.addEventListener("pagehide", () => setActive(false));
})();`;

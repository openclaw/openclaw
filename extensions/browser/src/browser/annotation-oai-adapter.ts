/** Compatibility only: all annotation state and behavior belong to the native page API. */
export const browserAnnotationOaiAdapterSource = String.raw`(() => {
  const native = document.openclaw?.annotation;
  if (!native || document.oai?.annotation) return;
  const namespace = document.oai ?? {};
  const api = {
    registerSurface: (options) => native.registerSurface(options),
    registerControls(options) {
      const handle = native.registerControls(options);
      const forward = (event) => {
        if (event.target !== options.targets) return;
        options.targets.dispatchEvent(new CustomEvent("oaiannotationcontrolchange", { detail: event.detail }));
      };
      options.targets.addEventListener("openclawannotationcontrolchange", forward);
      return {
        update: (next) => handle.update(next),
        dispose() {
          options.targets.removeEventListener("openclawannotationcontrolchange", forward);
          handle.dispose();
        },
      };
    },
    toggle: (active) => native.toggle(active),
    isActive: () => native.isActive(),
    request: (element, options) => native.request(element, options),
  };
  document.addEventListener("openclawannotationmodechange", (event) => {
    if (event.target === document) document.dispatchEvent(new CustomEvent("oaiannotationmodechange", { detail: event.detail }));
  });
  Object.defineProperty(namespace, "annotation", { value: api, enumerable: true });
  if (!document.oai) Object.defineProperty(document, "oai", { value: namespace });
})();`;

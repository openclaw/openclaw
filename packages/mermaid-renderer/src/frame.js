// A classic script is required here: opaque sandbox frames cannot import
// same-origin ES modules without relaxing the host's asset CORS policy.
(() => {
  const pele = globalThis.pele;
  const truncateUtf16Safe = (value, maxLength) => {
    if (value.length <= maxLength) {
      return value;
    }
    const boundary =
      /[\uD800-\uDBFF]/u.test(value[maxLength - 1]) && /[\uDC00-\uDFFF]/u.test(value[maxLength])
        ? maxLength - 1
        : maxLength;
    return value.slice(0, boundary);
  };
  // Both application scripts are already loaded. Diagram input can now cause
  // no script, image, stylesheet, font, fetch, or nested-frame network requests.
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
  document.head.append(policy);

  const initialize = (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== "openclaw:mermaid-init" ||
      !event.ports[0]
    ) {
      return;
    }
    window.removeEventListener("message", initialize);
    const port = event.ports[0];
    const properties = event.data.presentationAttributes;
    let busy = false;
    const render = ({
      data: { id, source, theme, maxSourceLength, maxEdges, maxSvgLength, maxSvgElements },
    }) => {
      if (busy) {
        return;
      }
      busy = true;
      const container = document.createElement("div");
      document.body.replaceChildren(container);
      try {
        // Host options are never merged with source configuration. Links, images and
        // trusted markup callbacks remain disabled even when front matter requests them.
        const { svg } = pele.render(source, {
          idPrefix: `diagram-${id}`,
          fontFamily: theme.fontFamily,
          // Measure labels at chat scale; shrinking only the exported text would clip nodes.
          fontSize: 14,
          limit: maxSourceLength,
          maxEdges,
          outputLimit: maxSvgLength,
          links: false,
          images: false,
        });
        if (svg.length > maxSvgLength) {
          throw new Error("Mermaid diagram output is too large.");
        }
        container.innerHTML = svg;
        const root = container.querySelector("svg");
        if (!root) {
          throw new Error("Mermaid returned an invalid diagram.");
        }
        // Resolve inherited CSS variables before the result becomes a standalone
        // image. The passive host deliberately discards all source CSS afterwards.
        for (const [property, value] of Object.entries({
          bg: theme.background,
          fg: theme.foreground,
          muted: theme.muted,
          line: theme.muted,
          surface: theme.background,
          "surface-alt": theme.background,
          border: theme.border,
          accent: theme.accent,
          font: theme.fontFamily,
        })) {
          root.style.setProperty(`--pele-${property}`, value);
        }
        const elements = [root, ...root.querySelectorAll("*")];
        if (elements.length > maxSvgElements) {
          throw new Error("Mermaid diagram contains too many elements.");
        }
        // Freeze browser-computed presentation before removing CSS. The parent
        // can then discard all CSS without parsing untrusted style expressions.
        const styles = elements.map((element) => {
          const computed = getComputedStyle(element);
          return properties.map((property) => [property, computed.getPropertyValue(property)]);
        });
        elements.forEach((element, index) => {
          for (const [property, value] of styles[index]) {
            if (value) {
              element.setAttribute(property, value);
            }
          }
          element.removeAttribute("style");
        });
        root.querySelectorAll("style").forEach((style) => style.remove());
        const result = new XMLSerializer().serializeToString(root);
        if (result.length > maxSvgLength) {
          throw new Error("Mermaid diagram output is too large.");
        }
        port.postMessage({ id, svg: result });
      } catch (error) {
        port.postMessage({
          id,
          error: truncateUtf16Safe(String(error instanceof Error ? error.message : error), 1_000),
        });
      } finally {
        document.body.replaceChildren();
        busy = false;
      }
    };
    port.addEventListener("message", render);
    port.start();
    port.postMessage({ type: "ready" });
  };
  window.addEventListener("message", initialize);
})();

/** Serialized diagnostic: cached display must match the settled prior visit. */
export function readWarmPageSignature() {
  const pane = document.querySelector(".chat-pane-cache__pane--active");
  const rect = (element: Element) => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map((value) => Math.round(value * 2) / 2);
  };
  const visible = (element: Element) =>
    element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const regions = {
    header: ".chat-pane__header",
    transcript: ".chat-thread",
    composer: ".agent-chat__composer-shell",
    details: ".chat-details",
    dashboard: "openclaw-board-view",
  };
  const signatures: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, selector] of Object.entries(regions)) {
    const elements = [...(pane?.querySelectorAll<HTMLElement>(selector) ?? [])].filter(visible);
    if (!elements.length && name !== "dashboard") missing.push(name);
    const parts = elements.map((element) => {
      const thread = element.matches(".chat-thread");
      const bounds = element.getBoundingClientRect();
      const rows = thread
        ? [...element.querySelectorAll<HTMLElement>(".chat-virtual-row")].filter((row) => {
            const box = row.getBoundingClientRect();
            return visible(row) && box.bottom > bounds.top && box.top < bounds.bottom;
          })
        : [element];
      return {
        geometry: rect(element),
        rows: rows.map((row) => ({
          key: row.getAttribute("data-virtual-row-key"),
          geometry: rect(row),
          text: [...row.querySelectorAll<HTMLElement>(".chat-pane__connection")]
            .reduce((text, connection) => text.replace(connection.innerText, ""), row.innerText)
            .replace(/\s+/gu, " ")
            .trim(),
          images: [...row.querySelectorAll<HTMLImageElement>("img")]
            .filter(visible)
            .map((image) => ({
              alt: image.alt,
              size: [image.complete ? image.naturalWidth : 0, image.naturalHeight],
              geometry: rect(image),
            })),
        })),
      };
    });
    signatures[name] = JSON.stringify(parts);
  }
  const skeletons = [
    ...(pane?.querySelectorAll(".lazy-view-state--loading, openclaw-panel-loading-skeleton") ?? []),
  ].filter(visible).length;
  const imagesReady = [...(pane?.querySelectorAll<HTMLImageElement>(".chat-thread img") ?? [])]
    .filter(visible)
    .every((image) => image.complete && image.naturalWidth > 0);
  const readiness = Reflect.get(window, "__readWidgetReadiness")?.();
  const dashboardContentsVerified =
    signatures.dashboard === "[]" || typeof readiness?.firstBoardReadyMs === "number";
  return { signatures, missing, skeletons, imagesReady, dashboardContentsVerified };
}

import { canonicalLobsterLook, lobsterLookStyle, LOBSTER_PET_PALETTES } from "./api.ts";
import { renderLobsterSvg } from "./lobster-pet-look.tsx";

// Only presentation used by our trusted lobster artwork is baked. This is not
// an SVG importer: geometry, text and local definitions come from the renderer.
const PRESENTATION_PROPERTIES = [
  "color",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-dasharray",
  "stroke-dashoffset",
  "opacity",
  "filter",
  "clip-path",
  "mask",
  "display",
  "visibility",
  "transform",
  "transform-origin",
  "transform-box",
  "shape-rendering",
  "paint-order",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "white-space",
] as const;

/** Lazy artwork boundary; callers retain ownership of selection and composition. */
export async function loadLobsterImage(paletteId: string): Promise<HTMLImageElement | null> {
  const palette = LOBSTER_PET_PALETTES.find((entry) => entry.id === paletteId);
  if (!palette) {
    return null;
  }

  const host = document.createElement("div");
  try {
    const look = canonicalLobsterLook(palette);
    host.className = "lobster-pet lobster-pet--palette-" + palette.id;
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      lobsterLookStyle(look) +
      ";position:fixed;left:-10000px;top:0;bottom:auto;width:120px;height:105px;opacity:0;pointer-events:none;transform:none";
    document.body.append(host);
    const artwork = renderLobsterSvg(look, { standalone: true });
    const source = artwork.firstElementChild;
    if (!(source instanceof SVGSVGElement)) {
      return null;
    }
    host.append(artwork);

    // Use the neutral pose, not a time sample (blink/breathe have seeded delays).
    // Walk both parallel DOM trees in document order. This includes gradient,
    // mask and text descendants without querying or indexing the composed page.
    const walk = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT);
    for (let original: Node | null = source; original; original = walk.nextNode()) {
      if (original instanceof SVGElement) {
        original.style.setProperty("animation", "none", "important");
        original.style.setProperty("transition", "none", "important");
      }
    }
    const clone = source.cloneNode(true);
    if (!(clone instanceof SVGSVGElement)) {
      return null;
    }
    const copyWalk = document.createTreeWalker(clone, NodeFilter.SHOW_ELEMENT);
    walk.currentNode = source;
    for (
      let original: Node | null = source, copy: Node | null = clone;
      original && copy;
      original = walk.nextNode(), copy = copyWalk.nextNode()
    ) {
      if (!(original instanceof SVGElement) || !(copy instanceof SVGElement)) {
        continue;
      }
      const computed = getComputedStyle(original);
      copy.removeAttribute("class");
      copy.removeAttribute("style");
      for (const property of PRESENTATION_PROPERTIES) {
        // Browsers may resolve fragment paint/filter URLs against the page.
        // Keep any definitions inside this standalone SVG, never on that page.
        const value = computed
          .getPropertyValue(property)
          .replace(/url\(["']?[^)"']*#([^)"']+)["']?\)/g, 'url("#$1")');
        copy.style.setProperty(property, value);
      }
    }

    // Some canonical sprites extend past their nominal viewBox (balloon string,
    // retro antennae). Retain them and a small halo, without square stretching.
    const bounds = source.getBBox();
    const viewBox = source.viewBox.baseVal;
    const x = Math.min(viewBox.x, bounds.x) - 4;
    const y = Math.min(viewBox.y, bounds.y) - 4;
    const width = Math.max(viewBox.x + viewBox.width, bounds.x + bounds.width) - x + 4;
    const height = Math.max(viewBox.y + viewBox.height, bounds.y + bounds.height) - y + 4;
    clone.setAttribute("viewBox", [x, y, width, height].join(" "));
    clone.setAttribute("width", String(width));
    clone.setAttribute("height", String(height));
    const image = new Image();
    image.src =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent(new XMLSerializer().serializeToString(clone));
    await image.decode();
    return image;
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

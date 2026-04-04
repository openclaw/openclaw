const ext = globalThis.browser ?? globalThis.chrome;
const SLOT_OPTIONS = ["auto", "head", "face", "body", "neck", "companion", "aura"];
const RUNTIME_STYLE_ID = "wig-forge-runtime-styles";

const RARITY_THEMES = {
  common: {
    accent: "#9b8e85",
    accentSoft: "rgba(155, 142, 133, 0.2)",
    glow: "rgba(210, 197, 187, 0.36)",
  },
  uncommon: {
    accent: "#6f8d5e",
    accentSoft: "rgba(111, 141, 94, 0.24)",
    glow: "rgba(170, 204, 146, 0.34)",
  },
  rare: {
    accent: "#d68d34",
    accentSoft: "rgba(214, 141, 52, 0.24)",
    glow: "rgba(255, 214, 126, 0.34)",
  },
  epic: {
    accent: "#9b5fe2",
    accentSoft: "rgba(155, 95, 226, 0.22)",
    glow: "rgba(197, 164, 255, 0.34)",
  },
  mythic: {
    accent: "#d54a82",
    accentSoft: "rgba(213, 74, 130, 0.24)",
    glow: "rgba(255, 154, 207, 0.38)",
  },
};

let cleanupSelection = null;
let currentConfig = null;
let selectionInFlight = false;
let advanceSelection = null;
let activePreviewController = null;

ensureRuntimeStyles();

ext.runtime.onMessage.addListener((message) => {
  if (!message) {
    return undefined;
  }

  if (
    message.type !== "wig-forge:start-selection" &&
    message.type !== "wig-forge:advance-capture"
  ) {
    return undefined;
  }

  currentConfig = {
    gatewayBaseUrl: String(message.gatewayBaseUrl || "http://127.0.0.1:18789"),
    inventoryKey: String(message.inventoryKey || "default-web"),
  };

  if (message.type === "wig-forge:advance-capture") {
    advanceCaptureFlow(currentConfig);
  } else {
    beginSelectionMode(currentConfig);
  }

  return undefined;
});

function ensureRuntimeStyles() {
  if (document.getElementById(RUNTIME_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = RUNTIME_STYLE_ID;
  style.textContent = `
    .wf-highlight {
      position: fixed;
      z-index: 2147483646;
      pointer-events: none;
      display: none;
      border: 2px solid rgba(255, 190, 113, 0.92);
      border-radius: 16px;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0.02)),
        rgba(255, 175, 97, 0.1);
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.5) inset,
        0 16px 40px rgba(36, 18, 8, 0.16);
      transition:
        opacity 140ms ease,
        transform 180ms ease,
        border-color 180ms ease;
      transform: translateZ(0);
    }

    .wf-badge {
      position: fixed;
      z-index: 2147483647;
      left: 18px;
      bottom: 18px;
      max-width: min(420px, calc(100vw - 36px));
      padding: 12px 16px;
      border-radius: 999px;
      background: rgba(13, 16, 26, 0.86);
      color: #f8f4ed;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 22px 48px rgba(6, 10, 20, 0.28);
      backdrop-filter: blur(18px);
      font: 600 12px/1.35 "Avenir Next", "Helvetica Neue", sans-serif;
      letter-spacing: 0.01em;
    }

    .wf-preview-backdrop,
    .wf-reveal-root {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      isolation: isolate;
    }

    .wf-preview-backdrop {
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      padding: 22px;
      background:
        radial-gradient(circle at top left, rgba(214, 141, 52, 0.18), transparent 24%),
        radial-gradient(circle at top right, rgba(155, 95, 226, 0.12), transparent 26%),
        rgba(7, 10, 18, 0.52);
      backdrop-filter: blur(14px);
    }

    .wf-preview-panel {
      width: 368px;
      max-width: calc(100vw - 44px);
      border-radius: 30px;
      overflow: hidden;
      color: #f8f4ed;
      background:
        linear-gradient(180deg, rgba(24, 19, 29, 0.97), rgba(15, 18, 30, 0.96));
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow:
        0 30px 80px rgba(5, 9, 18, 0.34),
        inset 0 1px 0 rgba(255,255,255,0.04);
      font: 500 12px/1.5 "Avenir Next", "Helvetica Neue", sans-serif;
      transform: translateY(0);
    }

    .wf-preview-hero {
      position: relative;
      display: grid;
      grid-template-columns: 124px minmax(0, 1fr);
      gap: 16px;
      align-items: center;
      padding: 18px 18px 16px;
      background:
        radial-gradient(circle at top left, rgba(255, 201, 132, 0.18), transparent 36%),
        radial-gradient(circle at top right, rgba(197, 164, 255, 0.16), transparent 38%),
        linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01));
    }

    .wf-preview-figure {
      width: 124px;
      height: 124px;
      padding: 12px;
      border-radius: 26px;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(255,255,255,0.92), rgba(255,255,255,0.08)),
        linear-gradient(135deg, rgba(214,141,52,0.18), rgba(155,95,226,0.12));
      box-shadow:
        0 18px 34px rgba(6, 10, 20, 0.24),
        inset 0 1px 0 rgba(255,255,255,0.24);
    }

    .wf-preview-figure img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
    }

    .wf-kicker {
      color: rgba(236, 226, 214, 0.62);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }

    .wf-preview-title {
      margin-top: 10px;
      font: 700 24px/0.96 "Iowan Old Style", "Palatino Linotype", serif;
      letter-spacing: -0.05em;
    }

    .wf-preview-copy {
      margin-top: 8px;
      color: rgba(236, 226, 214, 0.74);
      font-size: 13px;
      line-height: 1.55;
    }

    .wf-preview-meta {
      margin-top: 8px;
      color: rgba(236, 226, 214, 0.56);
      font-size: 12px;
      line-height: 1.5;
    }

    .wf-preview-body {
      padding: 0 18px 18px;
    }

    .wf-field {
      display: grid;
      gap: 6px;
      margin-top: 12px;
    }

    .wf-field-label {
      color: rgba(236, 226, 214, 0.66);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .wf-field input,
    .wf-field select {
      box-sizing: border-box;
      width: 100%;
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 11px 12px;
      background: rgba(12, 18, 31, 0.88);
      color: #f8f4ed;
      font: 500 13px/1.4 "Avenir Next", "Helvetica Neue", sans-serif;
    }

    .wf-preview-bar {
      margin-top: 14px;
      padding: 12px 13px;
      border-radius: 18px;
      color: rgba(236, 226, 214, 0.62);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01)),
        rgba(10, 14, 24, 0.9);
      border: 1px solid rgba(255,255,255,0.05);
      font-size: 12px;
      line-height: 1.5;
    }

    .wf-preview-actions,
    .wf-reveal-actions {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }

    .wf-btn {
      appearance: none;
      min-height: 42px;
      padding: 0 14px;
      border-radius: 999px;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition:
        transform 180ms ease,
        opacity 180ms ease,
        box-shadow 180ms ease;
      font: 700 12px/1 "Avenir Next", "Helvetica Neue", sans-serif;
      letter-spacing: 0.02em;
    }

    .wf-btn:hover {
      transform: translateY(-1px);
    }

    .wf-btn-secondary {
      flex: 1;
      border: 1px solid rgba(255,255,255,0.1);
      background: rgba(12, 18, 31, 0.88);
      color: #f8f4ed;
    }

    .wf-btn-primary {
      flex: 1.2;
      border: 0;
      color: #161212;
      background: linear-gradient(135deg, #ffd084, #ff9ccb);
      box-shadow: 0 16px 30px rgba(255, 156, 203, 0.18);
    }

    .wf-reveal-root {
      --wf-accent: #d68d34;
      --wf-accent-soft: rgba(214, 141, 52, 0.22);
      --wf-glow: rgba(255, 214, 126, 0.34);
      pointer-events: none;
      perspective: 1200px;
      transform-style: preserve-3d;
    }

    .wf-reveal-scrim {
      position: absolute;
      inset: 0;
      background:
        radial-gradient(circle at top, rgba(255,255,255,0.08), transparent 24%),
        rgba(7, 10, 18, 0.42);
      backdrop-filter: blur(10px);
      opacity: 0;
    }

    .wf-reveal-ripple {
      position: absolute;
      width: 164px;
      height: 164px;
      margin-left: -82px;
      margin-top: -82px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255,255,255,0.14), transparent 62%);
      border: 1px solid rgba(255,255,255,0.4);
      box-shadow:
        0 0 0 1px var(--wf-accent-soft) inset,
        0 0 38px var(--wf-glow);
      opacity: 0;
    }

    .wf-reveal-trail {
      position: absolute;
      height: 4px;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,0.78) 22%,
        var(--wf-accent) 56%,
        rgba(255,255,255,0) 100%
      );
      box-shadow: 0 0 26px var(--wf-glow);
      opacity: 0;
      filter: blur(0.6px);
      pointer-events: none;
    }

    .wf-reveal-source {
      position: absolute;
      display: grid;
      place-items: center;
      overflow: hidden;
      border-radius: 20px;
      border: 1px solid rgba(255,255,255,0.58);
      box-shadow:
        0 0 0 1px rgba(255,255,255,0.22) inset,
        0 18px 40px rgba(6,10,20,0.14);
      background: linear-gradient(180deg, rgba(255,255,255,0.16), rgba(255,255,255,0.02));
      opacity: 0;
    }

    .wf-reveal-source-fill {
      position: absolute;
      inset: -18%;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.42), transparent 28%),
        radial-gradient(circle at bottom right, var(--wf-glow), transparent 34%),
        linear-gradient(135deg, var(--wf-accent-soft), rgba(255,255,255,0.04));
      opacity: 0.9;
    }

    .wf-reveal-source-shell {
      position: relative;
      z-index: 1;
      width: 100%;
      height: 100%;
      padding: 10%;
      display: grid;
      place-items: center;
    }

    .wf-reveal-source-shell img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      filter: drop-shadow(0 10px 18px rgba(6,10,20,0.18));
    }

    .wf-reveal-slice {
      position: absolute;
      z-index: 2;
      left: -12%;
      right: -12%;
      top: 50%;
      height: 3px;
      border-radius: 999px;
      background: linear-gradient(
        90deg,
        rgba(255,255,255,0) 0%,
        rgba(255,255,255,0.96) 18%,
        var(--wf-accent) 50%,
        rgba(255,255,255,0.96) 82%,
        rgba(255,255,255,0) 100%
      );
      box-shadow: 0 0 28px rgba(255,255,255,0.42);
      transform: translateY(-50%) rotate(-14deg) scaleX(0.24);
      opacity: 0;
      transform-origin: center center;
    }

    .wf-reveal-figure {
      position: absolute;
      display: grid;
      place-items: center;
      pointer-events: none;
      transform-origin: center center;
      isolation: isolate;
    }

    .wf-reveal-glow {
      position: absolute;
      inset: 12%;
      border-radius: 999px;
      background: radial-gradient(circle, var(--wf-glow), transparent 72%);
      filter: blur(18px);
      opacity: 0;
      transform: scale(0.92);
    }

    .wf-reveal-shell {
      position: relative;
      width: 100%;
      height: 100%;
      padding: 18px;
      border-radius: 34px;
      background:
        radial-gradient(circle at top, rgba(255,255,255,0.96), rgba(255,255,255,0.1)),
        linear-gradient(135deg, var(--wf-accent-soft), rgba(255,255,255,0.04));
      box-shadow:
        0 30px 70px rgba(4, 8, 18, 0.26),
        inset 0 1px 0 rgba(255,255,255,0.3);
      overflow: hidden;
    }

    .wf-reveal-shell img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      display: block;
      position: relative;
      z-index: 1;
    }

    .wf-reveal-card {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 24px;
      display: grid;
      gap: 10px;
      padding: 18px;
      border-radius: 28px;
      background:
        linear-gradient(180deg, rgba(24,19,29,0.94), rgba(13,16,26,0.96));
      color: #f8f4ed;
      border: 1px solid rgba(255,255,255,0.08);
      box-shadow: 0 24px 54px rgba(6,10,20,0.24);
      opacity: 0;
      transform: translateY(16px);
      transform-origin: center bottom;
      pointer-events: auto;
    }

    .wf-reveal-card::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 68px;
      background: linear-gradient(180deg, rgba(255,255,255,0.08), transparent);
      pointer-events: none;
    }

    .wf-reveal-card h3 {
      margin: 0;
      font: 700 28px/0.96 "Iowan Old Style", "Palatino Linotype", serif;
      letter-spacing: -0.05em;
    }

    .wf-reveal-line {
      color: rgba(236, 226, 214, 0.66);
      font: 500 13px/1.55 "Avenir Next", "Helvetica Neue", sans-serif;
    }

    .wf-chip-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .wf-chip {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(255,255,255,0.07);
      color: rgba(248, 244, 237, 0.82);
      font: 700 11px/1 "Avenir Next", "Helvetica Neue", sans-serif;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .wf-chip.wf-chip-rarity {
      background: var(--wf-accent-soft);
      color: #fff3df;
    }

    .wf-reveal-dismiss {
      position: absolute;
      top: 18px;
      right: 18px;
      width: 40px;
      height: 40px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(12,18,31,0.72);
      color: #f8f4ed;
      cursor: pointer;
      pointer-events: auto;
      font: 600 16px/1 "Avenir Next", "Helvetica Neue", sans-serif;
      backdrop-filter: blur(10px);
    }

    .wf-reveal-sparks {
      position: absolute;
      width: 180px;
      height: 180px;
      pointer-events: none;
    }

    .wf-reveal-sparks span {
      position: absolute;
      left: 50%;
      top: 50%;
      width: 12px;
      height: 12px;
      margin-left: -6px;
      margin-top: -6px;
      border-radius: 999px;
      background: radial-gradient(circle, rgba(255,255,255,1), var(--wf-accent) 64%, rgba(255,255,255,0) 72%);
      box-shadow: 0 0 18px var(--wf-glow);
      opacity: 0;
    }

    @media (max-width: 680px) {
      .wf-preview-backdrop {
        padding: 12px;
        align-items: stretch;
      }

      .wf-preview-panel {
        width: 100%;
        align-self: end;
      }

      .wf-preview-hero {
        grid-template-columns: 1fr;
      }

      .wf-preview-figure {
        width: 100%;
        height: 200px;
      }

      .wf-reveal-card {
        left: 16px;
        right: 16px;
        bottom: 16px;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .wf-highlight,
      .wf-badge,
      .wf-preview-panel,
      .wf-reveal-scrim,
      .wf-reveal-source,
      .wf-reveal-figure,
      .wf-reveal-glow,
      .wf-reveal-card,
      .wf-btn {
        transition: none !important;
        animation: none !important;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

function beginSelectionMode(config) {
  if (cleanupSelection) {
    cleanupSelection();
  }

  ensureRuntimeStyles();

  const highlight = document.createElement("div");
  highlight.className = "wf-highlight";

  const badge = document.createElement("div");
  badge.className = "wf-badge";
  badge.textContent =
    "Veil: hover an element, click to refine or press the shortcut again to forge, Esc to cancel";

  document.documentElement.appendChild(highlight);
  document.documentElement.appendChild(badge);

  let hovered = null;
  let lastPointer = null;

  const onMove = (event) => {
    lastPointer = {
      x: event.clientX,
      y: event.clientY,
    };
    const target = resolveSelectableTarget(event.target);
    hovered = target;
    if (!target) {
      highlight.style.display = "none";
      return;
    }
    const rect = target.getBoundingClientRect();
    if (!isReasonableRect(rect)) {
      highlight.style.display = "none";
      return;
    }
    highlight.style.display = "block";
    positionBox(highlight, rect);
  };

  const captureTarget = async ({ target, rect, clickPoint, shouldPrompt }) => {
    if (selectionInFlight) {
      return;
    }
    if (!target) {
      return;
    }
    if (!isReasonableRect(rect)) {
      return;
    }

    selectionInFlight = true;
    badge.textContent = "Veil: freezing the page surface...";

    try {
      const capture = await ext.runtime.sendMessage({ type: "wig-forge:capture-visible-tab" });
      if (!capture?.ok || !capture.dataUrl) {
        throw new Error(capture?.error || "Could not capture the current tab.");
      }

      badge.textContent = "Veil: separating the clicked fragment...";
      const cutout = await globalThis.WigForgeSegmentation.extractCutoutFromDataUrl({
        dataUrl: capture.dataUrl,
        rect,
        clickPoint,
        devicePixelRatio: window.devicePixelRatio || 1,
      });

      cleanupSelection?.();

      let preview = null;
      if (shouldPrompt) {
        preview = await presentForgePreview({
          cutout,
          rect,
          target,
          config,
        });
        if (!preview) {
          return;
        }
      }

      const payload = buildForgePayload({
        sourceDataUrl: cutout.dataUrl,
        rect,
        target,
        config,
        cutout,
        overrides: preview || buildAutoForgeOverrides(target),
      });

      const result = await postForgeRequest(config.gatewayBaseUrl, payload);
      showForgeResult({
        asset: result.asset,
        cutoutDataUrl: cutout.dataUrl,
        selectionRect: rect,
        captureMode: cutout.mode,
        confidence: cutout.diagnostics?.confidence,
        gatewayBaseUrl: config.gatewayBaseUrl,
        roomUrl: result.roomUrl,
      });
    } catch (error) {
      badge.textContent = `Veil failed: ${error instanceof Error ? error.message : String(error)}`;
      badge.style.background = "rgba(73, 19, 27, 0.92)";
      setTimeout(() => {
        badge.remove();
      }, 2200);
    } finally {
      selectionInFlight = false;
    }
  };

  const advance = () => {
    if (selectionInFlight) {
      return;
    }

    const target = hovered;
    if (!target) {
      badge.textContent = "Veil: hover the fragment you want first, then press the shortcut again";
      return;
    }

    const rect = target.getBoundingClientRect();
    if (!isReasonableRect(rect)) {
      badge.textContent = "Veil: move to a visible fragment before forging";
      return;
    }

    badge.textContent = "Veil: lifting the hovered fragment...";
    const clickPoint = resolveCapturePoint(rect, lastPointer);
    void captureTarget({
      target,
      rect,
      clickPoint,
      shouldPrompt: false,
    });
  };

  const onClick = async (event) => {
    if (selectionInFlight) {
      return;
    }

    const target = hovered || resolveSelectableTarget(event.target);
    if (!target) {
      return;
    }

    const rect = target.getBoundingClientRect();
    if (!isReasonableRect(rect)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    await captureTarget({
      target,
      rect,
      clickPoint: {
        x: event.clientX,
        y: event.clientY,
      },
      shouldPrompt: true,
    });
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape") {
      cleanupSelection?.();
    }
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeyDown, true);

  cleanupSelection = () => {
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("keydown", onKeyDown, true);
    highlight.remove();
    badge.remove();
    selectionInFlight = false;
    cleanupSelection = null;
    advanceSelection = null;
  };

  advanceSelection = advance;
}

function resolveSelectableTarget(node) {
  if (!(node instanceof Element)) {
    return null;
  }
  return node.closest(
    "img, svg, canvas, picture, video, button, a, [role='img'], [data-wig-forge], div, span",
  );
}

function isReasonableRect(rect) {
  return rect.width >= 18 && rect.height >= 18 && rect.bottom >= 0 && rect.right >= 0;
}

function positionBox(node, rect) {
  node.style.left = `${Math.max(0, rect.left)}px`;
  node.style.top = `${Math.max(0, rect.top)}px`;
  node.style.width = `${Math.max(0, rect.width)}px`;
  node.style.height = `${Math.max(0, rect.height)}px`;
}

function resolveCapturePoint(rect, pointer) {
  if (pointer && pointFallsInsideRect(pointer, rect)) {
    return pointer;
  }
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
}

function pointFallsInsideRect(point, rect) {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

function buildForgePayload({ sourceDataUrl, rect, target, config, cutout, overrides }) {
  const nameHint = overrides?.nameHint || deriveNameHint(target);
  return {
    inventoryKey: config.inventoryKey,
    sourceDataUrl,
    originUrl: window.location.href,
    nameHint,
    slotHint: overrides?.slotHint || "auto",
    styleTags: deriveStyleTags(target),
    novelty: 0.78,
    maskQuality:
      typeof cutout?.diagnostics?.confidence === "number" ? cutout.diagnostics.confidence : 0.72,
    taskQuality: 0.8,
    styleFit: 0.68,
    captureMode: cutout?.mode || "rect-fallback",
    captureDiagnostics: cutout?.diagnostics,
    selectionRect: {
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

function deriveNameHint(target) {
  const candidates = [
    target.getAttribute("aria-label"),
    target.getAttribute("title"),
    target.getAttribute("alt"),
    target.textContent,
  ];
  const found = candidates.find((value) => value && value.trim());
  if (found) {
    return found.trim().replace(/\s+/g, " ").slice(0, 60);
  }
  return `${target.tagName.toLowerCase()} artifact`;
}

function deriveStyleTags(target) {
  const tags = new Set([target.tagName.toLowerCase()]);
  const classList = Array.from(target.classList || []).slice(0, 4);
  for (const className of classList) {
    tags.add(className.toLowerCase());
  }
  const text =
    `${target.getAttribute("alt") || ""} ${target.getAttribute("title") || ""}`.toLowerCase();
  if (text.includes("hat") || text.includes("cap")) tags.add("hat");
  if (text.includes("tie") || text.includes("ribbon")) tags.add("tie");
  if (text.includes("glow") || text.includes("spark")) tags.add("aura");
  return Array.from(tags).slice(0, 8);
}

function buildAutoForgeOverrides(target) {
  return {
    nameHint: deriveNameHint(target),
    slotHint: deriveSlotHint(target),
  };
}

async function postForgeRequest(gatewayBaseUrl, payload) {
  const response = await fetch(`${gatewayBaseUrl}/plugins/wig-forge/forge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Wig-Forge-Client": "browser-extension",
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error || `Forge request failed with ${response.status}`);
  }
  return data;
}

async function presentForgePreview({ cutout, rect, target, config }) {
  ensureRuntimeStyles();
  document.querySelectorAll(".wf-preview-backdrop").forEach((node) => {
    node.remove();
  });

  return await new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "wf-preview-backdrop";

    const panel = document.createElement("section");
    panel.className = "wf-preview-panel";

    const nameHint = deriveNameHint(target);
    const suggestedSlot = deriveSlotHint(target);
    panel.innerHTML = `
      <div class="wf-preview-hero">
        <div class="wf-preview-figure">
          <img alt="Cutout preview" src="${escapeAttribute(cutout.dataUrl)}" />
        </div>
        <div>
          <div class="wf-kicker">Veil Capture</div>
          <div class="wf-preview-title">${escapeHtml(nameHint)}</div>
          <div class="wf-preview-copy">
            Lift the object out of the page, rename it if needed, then let the forge roll slot and rarity.
          </div>
          <div class="wf-preview-meta">
            ${escapeHtml(cutout.mode)} · confidence ${formatPercent(cutout.diagnostics?.confidence)} · ${escapeHtml(window.location.hostname)}
          </div>
        </div>
      </div>
      <div class="wf-preview-body">
        <label class="wf-field">
          <span class="wf-field-label">Name</span>
          <input data-role="name" type="text" value="${escapeAttribute(nameHint)}" />
        </label>
        <label class="wf-field">
          <span class="wf-field-label">Slot</span>
          <select data-role="slot">${SLOT_OPTIONS.map((slot) => `<option value="${slot}"${slot === suggestedSlot ? " selected" : ""}>${slot}</option>`).join("")}</select>
        </label>
        <div class="wf-preview-bar">
          Selection ${Math.round(rect.width)} x ${Math.round(rect.height)} · Entry ${escapeHtml(config.inventoryKey)}
        </div>
        <div class="wf-preview-actions">
          <button data-role="cancel" type="button" class="wf-btn wf-btn-secondary">Keep Page</button>
          <button data-role="forge" type="button" class="wf-btn wf-btn-primary">Forge Drop</button>
        </div>
      </div>
    `;

    const cleanup = () => {
      window.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      if (activePreviewController?.backdrop === backdrop) {
        activePreviewController = null;
      }
    };

    const cancel = () => {
      cleanup();
      resolve(null);
    };

    const submit = () => {
      const nameInput = panel.querySelector("[data-role='name']");
      const slotSelect = panel.querySelector("[data-role='slot']");
      cleanup();
      resolve({
        nameHint:
          nameInput instanceof HTMLInputElement && nameInput.value.trim()
            ? nameInput.value.trim().slice(0, 80)
            : nameHint,
        slotHint:
          slotSelect instanceof HTMLSelectElement && slotSelect.value.trim()
            ? slotSelect.value.trim()
            : "auto",
      });
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    };

    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) {
        cancel();
      }
    });
    panel.querySelector("[data-role='cancel']")?.addEventListener("click", cancel);
    panel.querySelector("[data-role='forge']")?.addEventListener("click", submit);
    window.addEventListener("keydown", onKeyDown, true);
    backdrop.appendChild(panel);
    document.documentElement.appendChild(backdrop);
    activePreviewController = {
      backdrop,
      submit,
      cancel,
    };
  });
}

function advanceCaptureFlow(config) {
  if (activePreviewController) {
    activePreviewController.submit();
    return;
  }

  if (advanceSelection) {
    advanceSelection();
    return;
  }

  beginSelectionMode(config);
}

function deriveSlotHint(target) {
  const text =
    `${deriveNameHint(target)} ${(target.getAttribute("alt") || "").toLowerCase()} ${(target.getAttribute("title") || "").toLowerCase()}`.toLowerCase();
  if (text.includes("hat") || text.includes("cap") || text.includes("hair")) return "head";
  if (text.includes("mask") || text.includes("glasses") || text.includes("visor")) return "face";
  if (text.includes("tie") || text.includes("ribbon") || text.includes("scarf")) return "neck";
  if (text.includes("companion") || text.includes("pet") || text.includes("buddy"))
    return "companion";
  if (
    text.includes("glow") ||
    text.includes("spark") ||
    text.includes("halo") ||
    text.includes("aura")
  )
    return "aura";
  return "auto";
}

function showForgeResult(params) {
  const { asset, cutoutDataUrl, selectionRect, captureMode, confidence, gatewayBaseUrl, roomUrl } =
    params;

  ensureRuntimeStyles();
  document.querySelectorAll(".wf-reveal-root").forEach((node) => {
    node.remove();
  });

  const theme = RARITY_THEMES[asset.rarity] || RARITY_THEMES.rare;
  const root = document.createElement("div");
  root.className = "wf-reveal-root";
  root.style.setProperty("--wf-accent", theme.accent);
  root.style.setProperty("--wf-accent-soft", theme.accentSoft);
  root.style.setProperty("--wf-glow", theme.glow);

  const scrim = document.createElement("div");
  scrim.className = "wf-reveal-scrim";

  const destinationSize = Math.round(
    Math.max(220, Math.min(360, Math.max(selectionRect.width * 1.8, selectionRect.height * 1.8))),
  );
  const destinationLeft = Math.round(window.innerWidth / 2 - destinationSize / 2);
  const destinationTop = Math.round(Math.max(36, window.innerHeight * 0.12));
  const sourceCenterX = selectionRect.left + selectionRect.width / 2;
  const sourceCenterY = selectionRect.top + selectionRect.height / 2;
  const destinationCenterX = destinationLeft + destinationSize / 2;
  const destinationCenterY = destinationTop + destinationSize / 2;
  const translateX = sourceCenterX - destinationCenterX;
  const translateY = sourceCenterY - destinationCenterY;
  const startScale = Math.max(
    0.18,
    Math.min(0.84, Math.min(selectionRect.width, selectionRect.height) / destinationSize),
  );
  const liftTranslateX = (destinationCenterX - sourceCenterX) * 0.14;
  const liftTranslateY = (destinationCenterY - sourceCenterY) * 0.14;
  const trailLength = Math.hypot(
    destinationCenterX - sourceCenterX,
    destinationCenterY - sourceCenterY,
  );
  const trailAngle = Math.atan2(
    destinationCenterY - sourceCenterY,
    destinationCenterX - sourceCenterX,
  );

  const ripple = document.createElement("div");
  ripple.className = "wf-reveal-ripple";
  ripple.style.left = `${sourceCenterX}px`;
  ripple.style.top = `${sourceCenterY}px`;

  const trail = document.createElement("div");
  trail.className = "wf-reveal-trail";
  trail.style.left = `${sourceCenterX}px`;
  trail.style.top = `${sourceCenterY - 2}px`;
  trail.style.width = `${trailLength}px`;
  trail.style.transformOrigin = "0 50%";
  trail.style.transform = `rotate(${trailAngle}rad) scaleX(0.12)`;

  const source = document.createElement("div");
  source.className = "wf-reveal-source";
  positionBox(source, selectionRect);
  source.innerHTML = `
    <div class="wf-reveal-source-fill"></div>
    <div class="wf-reveal-source-shell">
      <img alt="" src="${escapeAttribute(cutoutDataUrl)}" />
    </div>
    <div class="wf-reveal-slice"></div>
  `;

  const figure = document.createElement("div");
  figure.className = "wf-reveal-figure";

  figure.style.left = `${destinationLeft}px`;
  figure.style.top = `${destinationTop}px`;
  figure.style.width = `${destinationSize}px`;
  figure.style.height = `${destinationSize}px`;

  figure.innerHTML = `
    <div class="wf-reveal-glow"></div>
    <div class="wf-reveal-shell">
      <img alt="${escapeAttribute(asset.name)}" src="${escapeAttribute(cutoutDataUrl)}" />
    </div>
  `;

  const sparks = document.createElement("div");
  sparks.className = "wf-reveal-sparks";
  sparks.style.left = `${destinationCenterX - 90}px`;
  sparks.style.top = `${destinationCenterY - 90}px`;
  sparks.innerHTML = buildRevealSparkMarkup();

  const absoluteRoomUrl = buildAbsoluteRoomUrl(gatewayBaseUrl, roomUrl);
  const chips = [asset.rarity, asset.slot, asset.visuals?.material, asset.visuals?.trim]
    .filter(Boolean)
    .slice(0, 4)
    .map(
      (value, index) =>
        `<span class="wf-chip ${index === 0 ? "wf-chip-rarity" : ""}">${escapeHtml(String(value))}</span>`,
    )
    .join("");

  const card = document.createElement("section");
  card.className = "wf-reveal-card";
  card.innerHTML = `
    <div class="wf-kicker">Wig Forge Drop</div>
    <h3>${escapeHtml(asset.name)}</h3>
    <div class="wf-reveal-line">
      ${escapeHtml(captureMode || "cutout")} · confidence ${formatPercent(confidence)} · ready for Veil
    </div>
    <div class="wf-chip-row">${chips}</div>
    <div class="wf-reveal-actions">
      <a class="wf-btn wf-btn-primary" href="${escapeAttribute(absoluteRoomUrl)}" target="_blank" rel="noreferrer">Enter Veil</a>
      <button type="button" class="wf-btn wf-btn-secondary" data-role="dismiss">Keep Browsing</button>
    </div>
  `;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "wf-reveal-dismiss";
  dismiss.textContent = "x";

  const teardown = () => {
    root.remove();
  };

  dismiss.addEventListener("click", teardown);
  card.querySelector("[data-role='dismiss']")?.addEventListener("click", teardown);

  root.appendChild(scrim);
  root.appendChild(ripple);
  root.appendChild(source);
  root.appendChild(trail);
  root.appendChild(figure);
  root.appendChild(sparks);
  root.appendChild(card);
  root.appendChild(dismiss);
  document.documentElement.appendChild(root);

  const reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;

  if (reducedMotion) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, fill: "forwards" });
    source.animate([{ opacity: 0 }, { opacity: 0.2 }], { duration: 120, fill: "forwards" });
    trail.animate([{ opacity: 0 }, { opacity: 0.38 }, { opacity: 0 }], {
      duration: 220,
      fill: "forwards",
    });
    figure.animate(
      [
        { opacity: 0, transform: "scale(0.94)" },
        { opacity: 1, transform: "scale(1)" },
      ],
      { duration: 220, easing: "ease-out", fill: "forwards" },
    );
    card.animate(
      [
        { opacity: 0, transform: "translateY(12px)" },
        { opacity: 1, transform: "translateY(0)" },
      ],
      { duration: 180, delay: 80, easing: "ease-out", fill: "forwards" },
    );
  } else {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 160,
      easing: "ease-out",
      fill: "forwards",
    });
    ripple.animate(
      [
        { opacity: 0, transform: "scale(0.48)" },
        { opacity: 0.9, transform: "scale(0.96)", offset: 0.32 },
        { opacity: 0, transform: "scale(1.24)" },
      ],
      {
        duration: 420,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );
    trail.animate(
      [
        { opacity: 0, transform: `rotate(${trailAngle}rad) scaleX(0.12)` },
        { opacity: 0.96, transform: `rotate(${trailAngle}rad) scaleX(1)`, offset: 0.24 },
        { opacity: 0.44, transform: `rotate(${trailAngle}rad) scaleX(1)`, offset: 0.62 },
        { opacity: 0, transform: `rotate(${trailAngle}rad) scaleX(1.02)` },
      ],
      {
        duration: 520,
        easing: "cubic-bezier(0.18, 0.9, 0.18, 1)",
        fill: "forwards",
      },
    );
    source.animate(
      [
        { opacity: 0.2, transform: "scale(0.96) rotate(-3deg)" },
        { opacity: 1, transform: "scale(1.02) rotate(-1deg)", offset: 0.18 },
        {
          opacity: 0,
          transform: `translate(${liftTranslateX}px, ${liftTranslateY}px) scale(0.74) rotate(8deg)`,
        },
      ],
      {
        duration: 460,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill: "forwards",
      },
    );
    source.querySelector(".wf-reveal-source-fill")?.animate(
      [
        { opacity: 0.42, transform: "scale(0.92)" },
        { opacity: 1, transform: "scale(1)", offset: 0.22 },
        { opacity: 0, transform: "scale(1.18)" },
      ],
      {
        duration: 380,
        easing: "ease-out",
        fill: "forwards",
      },
    );
    source.querySelector(".wf-reveal-source-shell img")?.animate(
      [
        {
          transform: "scale(1) rotate(0deg)",
          filter: "drop-shadow(0 10px 18px rgba(6,10,20,0.18))",
        },
        {
          transform: "scale(1.08) rotate(-2deg)",
          filter: "drop-shadow(0 14px 26px rgba(6,10,20,0.22))",
          offset: 0.28,
        },
        {
          transform: "scale(0.86) rotate(6deg)",
          filter: "drop-shadow(0 18px 28px rgba(6,10,20,0.1))",
        },
      ],
      {
        duration: 420,
        easing: "cubic-bezier(0.18, 0.9, 0.18, 1)",
        fill: "forwards",
      },
    );
    source.querySelector(".wf-reveal-slice")?.animate(
      [
        { opacity: 0, transform: "translateY(-50%) rotate(-14deg) scaleX(0.24)" },
        { opacity: 1, transform: "translateY(-50%) rotate(-14deg) scaleX(1.04)", offset: 0.38 },
        { opacity: 0, transform: "translateY(-50%) rotate(-14deg) scaleX(1.18)" },
      ],
      {
        duration: 340,
        delay: 40,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "forwards",
      },
    );
    figure.animate(
      [
        {
          opacity: 0.28,
          transform: `translate(${translateX}px, ${translateY}px) scale(${startScale}) rotate(-10deg)`,
          filter: "blur(2px)",
        },
        {
          opacity: 1,
          transform: "translate(0, 0) scale(1.04) rotate(0deg)",
          filter: "blur(0px)",
          offset: 0.72,
        },
        {
          opacity: 1,
          transform: "translate(0, 0) scale(1) rotate(0deg)",
          filter: "blur(0px)",
        },
      ],
      {
        duration: 620,
        easing: "cubic-bezier(0.18, 0.82, 0.18, 1)",
        fill: "forwards",
      },
    );
    figure
      .querySelector(".wf-reveal-shell")
      ?.animate(
        [
          { transform: "scale(0.92) rotate(-8deg)" },
          { transform: "scale(1.05) rotate(1deg)", offset: 0.72 },
          { transform: "scale(1) rotate(0deg)" },
        ],
        {
          duration: 620,
          easing: "cubic-bezier(0.18, 0.82, 0.18, 1)",
          fill: "forwards",
        },
      );
    figure.querySelector(".wf-reveal-glow")?.animate(
      [
        { opacity: 0, transform: "scale(0.84)" },
        { opacity: 1, transform: "scale(1.06)", offset: 0.7 },
        { opacity: 0.82, transform: "scale(1)" },
      ],
      {
        duration: 740,
        easing: "ease-out",
        fill: "forwards",
      },
    );
    animateRevealSparks(sparks);
    card.animate(
      [
        { opacity: 0, transform: "translateY(26px) rotateX(12deg) scale(0.96)" },
        { opacity: 1, transform: "translateY(0) rotateX(0deg) scale(1)" },
      ],
      {
        duration: 340,
        delay: 260,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill: "forwards",
      },
    );
  }

  globalThis.setTimeout(teardown, 5600);
}

function buildAbsoluteRoomUrl(gatewayBaseUrl, roomUrl) {
  if (roomUrl) {
    try {
      return new URL(roomUrl, gatewayBaseUrl).toString();
    } catch {}
  }
  return `${gatewayBaseUrl.replace(/\/$/, "")}/plugins/wig-forge/room`;
}

function buildRevealSparkMarkup() {
  return "<span></span><span></span><span></span><span></span><span></span><span></span>";
}

function animateRevealSparks(node) {
  const vectors = [
    { x: 0, y: -58, delay: 120 },
    { x: 52, y: -26, delay: 160 },
    { x: 58, y: 34, delay: 210 },
    { x: 0, y: 62, delay: 230 },
    { x: -54, y: 28, delay: 190 },
    { x: -48, y: -32, delay: 140 },
  ];

  Array.from(node.querySelectorAll("span")).forEach((spark, index) => {
    const vector = vectors[index] || { x: 0, y: -48, delay: 120 };
    spark.animate(
      [
        { opacity: 0, transform: "translate(0, 0) scale(0.38)" },
        { opacity: 1, transform: "translate(0, 0) scale(1)", offset: 0.24 },
        { opacity: 0, transform: `translate(${vector.x}px, ${vector.y}px) scale(0.72)` },
      ],
      {
        duration: 520,
        delay: vector.delay,
        easing: "cubic-bezier(0.18, 0.9, 0.18, 1)",
        fill: "forwards",
      },
    );
  });
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "n/a";
  }
  return `${Math.round(value * 100)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

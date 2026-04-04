import { WIG_FORGE_RARITIES, WIG_FORGE_SLOTS } from "./types.js";

export function renderWigForgeRoomPage(params: { inventoryKey: string }): string {
  const escapedInventoryKey = escapeHtml(params.inventoryKey);
  const slotOptionsHtml = WIG_FORGE_SLOTS.map(
    (slot) => `<option value="${escapeHtml(slot)}">${escapeHtml(slot)}</option>`,
  ).join("");
  const rarityOptionsHtml = WIG_FORGE_RARITIES.map(
    (rarity) => `<option value="${escapeHtml(rarity)}">${escapeHtml(rarity)}</option>`,
  ).join("");
  const slotsJson = JSON.stringify(WIG_FORGE_SLOTS);
  const rarityOrderJson = JSON.stringify([...WIG_FORGE_RARITIES].reverse());

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Veil</title>
    <style>
      :root {
        color-scheme: light;
        --paper: #f8f4eb;
        --paper-strong: rgba(255, 252, 246, 0.95);
        --paper-soft: rgba(255, 248, 238, 0.76);
        --ink: #1d1914;
        --muted: rgba(29, 25, 20, 0.68);
        --line: rgba(29, 25, 20, 0.1);
        --amber: #d77a28;
        --rose: #a64d79;
        --forest: #50653f;
        --shadow: 0 28px 72px rgba(40, 24, 15, 0.11);
        --panel-border: rgba(29, 25, 20, 0.08);
        --ease-standard: cubic-bezier(0.2, 0, 0, 1);
        --scene-scroll: 0;
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        margin: 0;
        min-height: 100%;
        overflow-x: hidden;
        background:
          radial-gradient(circle at top left, rgba(215, 122, 40, 0.18), transparent 22%),
          radial-gradient(circle at top right, rgba(166, 77, 121, 0.16), transparent 28%),
          linear-gradient(180deg, #fffdf8 0%, #f7f1e6 42%, #ecdfce 100%);
        color: var(--ink);
        font-family: "Avenir Next", "Helvetica Neue", sans-serif;
      }
      body {
        position: relative;
        isolation: isolate;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          linear-gradient(90deg, rgba(29, 25, 20, 0.03) 0, rgba(29, 25, 20, 0.03) 1px, transparent 1px, transparent 96px),
          linear-gradient(rgba(29, 25, 20, 0.025) 0, rgba(29, 25, 20, 0.025) 1px, transparent 1px, transparent 96px);
        opacity: 0.4;
        mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0.34), transparent 78%);
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        background:
          radial-gradient(circle at center, transparent 34%, rgba(50, 28, 18, 0.08) 100%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0));
        opacity: 0.8;
      }
      a {
        color: inherit;
      }
      button,
      input,
      select,
      textarea {
        font: inherit;
      }
      button {
        border: 0;
      }
      .veil-scene {
        position: fixed;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        overflow: hidden;
      }
      #veil-webgl {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        display: block;
        opacity: 0.82;
      }
      .veil-aurora,
      .veil-beam,
      .veil-halo {
        position: absolute;
        pointer-events: none;
      }
      .veil-aurora {
        border-radius: 50%;
        filter: blur(18px);
        mix-blend-mode: screen;
        opacity: 0.72;
      }
      .veil-aurora-a {
        top: -8vw;
        left: -10vw;
        width: 42vw;
        height: 42vw;
        background: radial-gradient(circle, rgba(255, 212, 164, 0.84), rgba(255, 212, 164, 0) 68%);
        transform: translate3d(0, calc(var(--scene-scroll) * -52px), 0);
      }
      .veil-aurora-b {
        top: 12vh;
        right: -8vw;
        width: 34vw;
        height: 34vw;
        background: radial-gradient(circle, rgba(214, 149, 196, 0.62), rgba(214, 149, 196, 0) 70%);
        transform: translate3d(0, calc(var(--scene-scroll) * -34px), 0);
      }
      .veil-halo {
        inset: auto;
        left: 12vw;
        bottom: -18vh;
        width: 54vw;
        height: 54vw;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 247, 233, 0.68), rgba(255, 247, 233, 0) 72%);
        transform: translate3d(0, calc(var(--scene-scroll) * 28px), 0);
      }
      .veil-beam {
        width: 1px;
        height: 56vh;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0));
        opacity: 0.48;
        filter: blur(0.2px);
      }
      .veil-beam-a {
        top: -10vh;
        left: 18vw;
        transform: rotate(18deg) translate3d(0, calc(var(--scene-scroll) * -16px), 0);
      }
      .veil-beam-b {
        top: 22vh;
        right: 18vw;
        height: 42vh;
        transform: rotate(-22deg) translate3d(0, calc(var(--scene-scroll) * -10px), 0);
      }
      .shell {
        width: min(1420px, calc(100vw - 40px));
        margin: 0 auto;
        padding: 28px 0 80px;
        position: relative;
        z-index: 1;
        perspective: 2200px;
        perspective-origin: 50% 10%;
      }
      [data-depth-card] {
        --parallax-offset: 0px;
        --card-rotate-x: 0deg;
        --card-rotate-y: 0deg;
        --card-lift: 0px;
        --card-scale: 1;
        --glare-x: 50%;
        --glare-y: 0%;
        --glare-opacity: 0;
        position: relative;
        transform-style: preserve-3d;
        will-change: transform;
        transform:
          translate3d(0, calc(var(--parallax-offset) + var(--card-lift)), 0)
          rotateX(var(--card-rotate-x))
          rotateY(var(--card-rotate-y))
          var(--card-base-transform, translateZ(0px))
          scale(var(--card-scale));
        transition:
          transform 220ms var(--ease-standard),
          box-shadow 220ms var(--ease-standard),
          border-color 220ms var(--ease-standard),
          background-color 220ms var(--ease-standard);
      }
      [data-depth-card]::before {
        content: "";
        position: absolute;
        inset: 1px;
        border-radius: inherit;
        pointer-events: none;
        background: radial-gradient(
          circle at var(--glare-x) var(--glare-y),
          rgba(255, 255, 255, calc(var(--glare-opacity) * 0.48)),
          rgba(255, 255, 255, 0) 42%
        );
        mix-blend-mode: screen;
      }
      .hero,
      .spotlight,
      .stage,
      .wishboard,
      .collection {
        overflow: hidden;
        isolation: isolate;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(249, 241, 230, 0.58)),
          linear-gradient(135deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.06));
        border: 1px solid var(--panel-border);
        box-shadow:
          0 34px 96px rgba(40, 24, 15, 0.12),
          inset 0 1px 0 rgba(255, 255, 255, 0.7),
          inset 0 -1px 0 rgba(255, 255, 255, 0.18);
        backdrop-filter: blur(18px) saturate(1.16);
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(360px, 1.15fr) minmax(320px, 0.85fr);
        gap: 26px;
        align-items: stretch;
      }
      .hero-copy,
      .hero-tools {
        position: relative;
        overflow: hidden;
        border-radius: 34px;
        padding: 34px;
        transform: translateZ(20px);
      }
      .hero-copy::after {
        content: "";
        position: absolute;
        top: -64px;
        right: -38px;
        width: 290px;
        height: 290px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(215, 122, 40, 0.18), transparent 66%);
        pointer-events: none;
      }
      .hero-tools {
        display: grid;
        gap: 20px;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        font: 700 11px/1 "Avenir Next", "Helvetica Neue", sans-serif;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: rgba(29, 25, 20, 0.56);
      }
      .eyebrow::before {
        content: "";
        width: 28px;
        height: 1px;
        background: rgba(29, 25, 20, 0.26);
      }
      h1,
      h2,
      h3,
      p {
        margin: 0;
      }
      h1 {
        margin-top: 18px;
        max-width: 10ch;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: clamp(3.2rem, 7.4vw, 5.9rem);
        line-height: 0.9;
        letter-spacing: -0.06em;
      }
      .lead {
        margin-top: 16px;
        max-width: 38rem;
        color: var(--muted);
        font-size: 1.04rem;
        line-height: 1.72;
      }
      .stat-rail {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 14px;
        margin-top: 28px;
      }
      .stat-tile {
        padding: 16px 16px 18px;
        border-radius: 22px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.28)),
          rgba(255, 255, 255, 0.22);
        box-shadow: 0 14px 30px rgba(37, 22, 14, 0.07);
      }
      .stat-label {
        color: rgba(29, 25, 20, 0.5);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
      }
      .stat-value {
        display: block;
        margin-top: 8px;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 2rem;
        line-height: 1;
        letter-spacing: -0.05em;
      }
      .stat-note {
        margin-top: 6px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.5;
      }
      .tools-label {
        font-size: 13px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: rgba(29, 25, 20, 0.48);
      }
      .meta-text,
      .section-copy,
      .asset-description,
      .asset-tags,
      .wish-note,
      .match-meta,
      .empty-copy,
      .status-pill,
      .collection-meta {
        color: var(--muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .inventory-form,
      .wish-form {
        display: grid;
        gap: 12px;
      }
      .field,
      .field-grid {
        display: grid;
        gap: 8px;
      }
      .field-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .field label,
      .inventory-form label {
        color: rgba(29, 25, 20, 0.72);
        font-size: 13px;
        font-weight: 700;
      }
      .inventory-row,
      .wish-grant-row,
      .action-row,
      .link-row,
      .filter-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      input,
      select,
      textarea {
        width: 100%;
        min-width: 0;
        border: 1px solid rgba(29, 25, 20, 0.12);
        border-radius: 18px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.76);
        color: var(--ink);
      }
      textarea {
        min-height: 102px;
        resize: vertical;
      }
      .inventory-row input {
        border-radius: 999px;
        flex: 1;
      }
      .primary-button,
      .ghost-link,
      .ghost-button {
        appearance: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 44px;
        padding: 12px 16px;
        border-radius: 999px;
        cursor: pointer;
        text-decoration: none;
        transition:
          transform 180ms var(--ease-standard),
          box-shadow 180ms var(--ease-standard),
          opacity 180ms var(--ease-standard),
          background-color 180ms var(--ease-standard),
          border-color 180ms var(--ease-standard);
      }
      .primary-button {
        background: linear-gradient(135deg, var(--amber), var(--rose));
        color: #fff8f0;
        box-shadow: 0 14px 32px rgba(166, 77, 121, 0.22);
        font-weight: 700;
      }
      .ghost-link,
      .ghost-button {
        background: rgba(255, 255, 255, 0.72);
        border: 1px solid rgba(29, 25, 20, 0.12);
        color: var(--ink);
        font-weight: 700;
      }
      .primary-button:hover,
      .ghost-link:hover,
      .ghost-button:hover {
        transform: translateY(-1px);
      }
      .primary-button:disabled,
      .ghost-button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
        box-shadow: none;
        transform: none;
      }
      .showcase-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
        gap: 26px;
        margin-top: 26px;
      }
      .spotlight,
      .stage,
      .wishboard,
      .collection {
        border-radius: 32px;
      }
      .spotlight {
        min-height: 560px;
      }
      .spotlight-body {
        display: grid;
        grid-template-columns: minmax(320px, 0.98fr) minmax(320px, 1.02fr);
        min-height: 560px;
      }
      .spotlight-canvas,
      .spotlight-copy-block {
        position: relative;
      }
      .spotlight-canvas {
        display: grid;
        place-items: center;
        padding: 30px;
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.9), transparent 36%),
          radial-gradient(circle at 24% 16%, rgba(215, 122, 40, 0.2), transparent 34%),
          radial-gradient(circle at 82% 26%, rgba(166, 77, 121, 0.16), transparent 28%),
          linear-gradient(180deg, rgba(255, 250, 243, 0.94), rgba(244, 233, 219, 0.74));
      }
      .spotlight-canvas::before {
        content: "";
        position: absolute;
        inset: 28px;
        border-radius: 30px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.88), transparent 54%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.08));
      }
      .spotlight-canvas::after {
        content: "";
        position: absolute;
        inset: 13% 16%;
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.54);
        box-shadow:
          0 0 0 26px rgba(255, 255, 255, 0.12),
          0 30px 60px rgba(51, 28, 18, 0.08);
        opacity: 0.76;
        transform:
          rotate(-8deg)
          translate3d(0, calc(var(--scene-scroll) * -14px), 0);
      }
      .spotlight-figure {
        position: relative;
        z-index: 1;
        width: min(520px, 100%);
        aspect-ratio: 1 / 1;
        border-radius: 34px;
        padding: 22px 22px 58px;
        overflow: hidden;
        background:
          radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.14), transparent 28%),
          radial-gradient(circle at 70% 74%, rgba(255, 189, 102, 0.18), transparent 34%),
          linear-gradient(180deg, rgba(29, 26, 28, 0.94), rgba(15, 17, 24, 0.98));
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 28px 50px rgba(45, 27, 18, 0.16);
        --card-base-transform: translateZ(36px);
        animation: breathe 4.2s ease-in-out infinite;
      }
      .spotlight-figure::after {
        content: "";
        position: absolute;
        inset: 8% 12%;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.34), transparent 70%);
        pointer-events: none;
      }
      .spotlight-figure::before,
      .slot-preview::before,
      .asset-figure::before,
      .market-selection-figure::before,
      .listing-figure::before {
        content: "";
        position: absolute;
        inset: 1px;
        border-radius: inherit;
        border: 1px solid rgba(255, 255, 255, 0.08);
        background:
          radial-gradient(circle at 24% 20%, rgba(255, 255, 255, 0.12), transparent 32%),
          linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0));
        pointer-events: none;
      }
      .spotlight-figure img,
      .slot-preview img,
      .asset-figure img,
      .market-selection-figure img,
      .listing-figure img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        position: relative;
        z-index: 1;
        filter: drop-shadow(0 16px 24px rgba(0, 0, 0, 0.28));
      }
      .spotlight-figure img[data-render-kind="vector"],
      .slot-preview img[data-render-kind="vector"],
      .asset-figure img[data-render-kind="vector"],
      .market-selection-figure img[data-render-kind="vector"],
      .listing-figure img[data-render-kind="vector"] {
        transform: scale(1.04);
        filter:
          saturate(1.06)
          drop-shadow(0 18px 26px rgba(0, 0, 0, 0.34))
          drop-shadow(0 0 18px rgba(255, 219, 160, 0.16));
      }
      .artifact-stage-meta {
        position: absolute;
        left: 12px;
        right: 12px;
        bottom: 12px;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        pointer-events: none;
      }
      .artifact-stage-pill,
      .signal-pill {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        padding: 0 9px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.16), rgba(255, 255, 255, 0.04)),
          rgba(11, 14, 20, 0.54);
        color: rgba(255, 247, 238, 0.88);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        backdrop-filter: blur(10px);
      }
      .signal-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .signal-pill {
        min-height: 28px;
        border-color: rgba(29, 25, 20, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(255, 255, 255, 0.52)),
          rgba(255, 255, 255, 0.2);
        color: rgba(29, 25, 20, 0.76);
      }
      .spotlight-copy-block {
        display: grid;
        align-content: start;
        gap: 22px;
        padding: 32px;
        transform: translateZ(24px);
      }
      .section-title {
        margin-top: 10px;
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 0.96;
        letter-spacing: -0.05em;
      }
      .badge-row,
      .palette-row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(29, 25, 20, 0.06);
        color: rgba(29, 25, 20, 0.72);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .badge.rarity-common {
        background: rgba(80, 72, 62, 0.08);
      }
      .badge.rarity-uncommon {
        background: rgba(80, 101, 63, 0.16);
        color: #465338;
      }
      .badge.rarity-rare {
        background: rgba(215, 122, 40, 0.18);
        color: #8d4f10;
      }
      .badge.rarity-epic {
        background: rgba(111, 75, 173, 0.16);
        color: #5d3693;
      }
      .badge.rarity-mythic {
        background: rgba(166, 77, 121, 0.18);
        color: #872953;
      }
      .detail-grid {
        display: grid;
        gap: 12px;
      }
      .detail-row {
        display: flex;
        justify-content: space-between;
        gap: 20px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(29, 25, 20, 0.08);
      }
      .detail-row strong {
        font-weight: 700;
      }
      .palette-swatch {
        width: 24px;
        height: 24px;
        border-radius: 999px;
        border: 1px solid rgba(29, 25, 20, 0.12);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.4);
      }
      .stage,
      .wishboard,
      .collection {
        padding: 26px;
      }
      .stage-head,
      .wish-head,
      .collection-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .stage-layout {
        display: grid;
        grid-template-columns: minmax(340px, 0.92fr) minmax(320px, 1.08fr);
        gap: 20px;
        margin-top: 24px;
      }
      .figure-scene {
        display: grid;
        gap: 16px;
        align-content: start;
      }
      .mannequin-stage {
        position: relative;
        min-height: 620px;
        padding: 24px;
        border-radius: 30px;
        overflow: hidden;
        background:
          radial-gradient(circle at top, rgba(255, 255, 255, 0.82), transparent 34%),
          radial-gradient(circle at 22% 18%, rgba(215, 122, 40, 0.16), transparent 26%),
          radial-gradient(circle at 84% 24%, rgba(166, 77, 121, 0.12), transparent 24%),
          linear-gradient(180deg, rgba(255, 250, 244, 0.94), rgba(241, 230, 215, 0.72));
        border: 1px solid rgba(29, 25, 20, 0.08);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.72),
          0 24px 46px rgba(35, 22, 15, 0.09);
      }
      .mannequin-stage::before {
        content: "";
        position: absolute;
        inset: 16px;
        border-radius: 24px;
        border: 1px solid rgba(255, 255, 255, 0.46);
        pointer-events: none;
      }
      .figure-orbit,
      .figure-floor,
      .figure-shadow {
        position: absolute;
        pointer-events: none;
      }
      .figure-orbit {
        border-radius: 50%;
        border: 1px solid rgba(255, 255, 255, 0.44);
        opacity: 0.86;
      }
      .figure-orbit-a {
        inset: 12% 16%;
        transform:
          rotate(-8deg)
          translate3d(0, calc(var(--scene-scroll) * -16px), 0);
      }
      .figure-orbit-b {
        inset: 18% 23%;
        border-style: dashed;
        border-color: rgba(255, 255, 255, 0.36);
        transform:
          rotate(9deg)
          translate3d(0, calc(var(--scene-scroll) * 10px), 0);
      }
      .figure-floor {
        left: 16%;
        right: 16%;
        bottom: 54px;
        height: 88px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(81, 54, 37, 0.14), rgba(81, 54, 37, 0) 74%);
        filter: blur(12px);
      }
      .figure-shadow {
        left: 28%;
        right: 28%;
        bottom: 78px;
        height: 42px;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(43, 28, 19, 0.24), rgba(43, 28, 19, 0) 76%);
        filter: blur(10px);
      }
      .mannequin-figure {
        position: relative;
        z-index: 1;
        width: min(360px, 100%);
        margin: 0 auto;
        aspect-ratio: 0.72 / 1;
        transform-style: preserve-3d;
      }
      .mannequin-core {
        position: absolute;
        inset: 0;
        z-index: 2;
      }
      .mannequin-shell {
        position: absolute;
        inset: 0;
        border-radius: 38% 38% 26% 26% / 18% 18% 24% 24%;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(239, 229, 219, 0.74)),
          linear-gradient(135deg, rgba(214, 141, 52, 0.08), rgba(166, 77, 121, 0.06));
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.82),
          0 22px 40px rgba(45, 29, 20, 0.08);
        opacity: 0.94;
      }
      .mannequin-head,
      .mannequin-torso,
      .mannequin-arm,
      .mannequin-leg {
        position: absolute;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(233, 223, 214, 0.9));
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
      }
      .mannequin-head {
        top: 5%;
        left: 34%;
        width: 32%;
        height: 18%;
        border-radius: 48% 48% 44% 44% / 42% 42% 56% 56%;
      }
      .mannequin-torso {
        top: 24%;
        left: 25%;
        width: 50%;
        height: 32%;
        border-radius: 36% 36% 24% 24% / 18% 18% 28% 28%;
      }
      .mannequin-arm {
        top: 26%;
        width: 14%;
        height: 32%;
        border-radius: 999px;
      }
      .mannequin-arm.left {
        left: 14%;
        rotate: 14deg;
      }
      .mannequin-arm.right {
        right: 14%;
        rotate: -14deg;
      }
      .mannequin-leg {
        top: 56%;
        width: 16%;
        height: 31%;
        border-radius: 999px;
      }
      .mannequin-leg.left {
        left: 31%;
      }
      .mannequin-leg.right {
        right: 31%;
      }
      .mannequin-neckline {
        position: absolute;
        top: 22%;
        left: 40%;
        width: 20%;
        height: 8%;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.7);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.88);
      }
      .mannequin-slot-layer,
      .mannequin-anchor {
        position: absolute;
        display: grid;
        place-items: center;
        border-radius: 24px;
      }
      .mannequin-slot-layer {
        overflow: hidden;
        padding: 10px;
        border: 1px solid rgba(255, 255, 255, 0.34);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.04)),
          rgba(255, 255, 255, 0.12);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.54),
          0 18px 28px rgba(42, 26, 18, 0.1);
        cursor: pointer;
        transition:
          transform 180ms var(--ease-standard),
          box-shadow 180ms var(--ease-standard),
          border-color 180ms var(--ease-standard);
      }
      .mannequin-slot-layer:hover {
        transform: translateY(-2px);
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.6),
          0 24px 34px rgba(42, 26, 18, 0.14);
      }
      .mannequin-slot-layer img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        display: block;
        transform:
          translate(var(--asset-shift-x, 0%), var(--asset-shift-y, 0%))
          scale(var(--asset-scale, 1))
          rotate(var(--asset-rotate, 0deg));
        transform-origin: var(--asset-origin-x, 50%) var(--asset-origin-y, 50%);
      }
      .mannequin-slot-layer::after {
        content: attr(data-slot-label);
        position: absolute;
        left: 10px;
        bottom: 8px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(29, 25, 20, 0.56);
        text-shadow: 0 1px 0 rgba(255, 255, 255, 0.7);
      }
      .mannequin-anchor {
        border: 1px dashed rgba(29, 25, 20, 0.16);
        background: rgba(255, 255, 255, 0.22);
      }
      .mannequin-anchor span {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgba(29, 25, 20, 0.34);
      }
      .mannequin-slot-glow {
        position: absolute;
        inset: 6%;
        border-radius: inherit;
        background: radial-gradient(circle, rgba(255, 255, 255, 0.44), rgba(255, 255, 255, 0) 72%);
        opacity: 0.72;
        pointer-events: none;
      }
      .mannequin-slot-glow.rarity-uncommon {
        background: radial-gradient(circle, rgba(141, 192, 118, 0.34), rgba(141, 192, 118, 0) 72%);
      }
      .mannequin-slot-glow.rarity-rare {
        background: radial-gradient(circle, rgba(255, 196, 108, 0.42), rgba(255, 196, 108, 0) 72%);
      }
      .mannequin-slot-glow.rarity-epic {
        background: radial-gradient(circle, rgba(180, 138, 255, 0.42), rgba(180, 138, 255, 0) 72%);
      }
      .mannequin-slot-glow.rarity-mythic {
        background: radial-gradient(circle, rgba(255, 142, 196, 0.46), rgba(255, 142, 196, 0) 72%);
      }
      .mannequin-slot-aura {
        inset: -6% -8% 2%;
        z-index: 0;
        border-radius: 40%;
      }
      .mannequin-slot-aura img {
        opacity: 0.88;
        filter: saturate(1.12) drop-shadow(0 0 22px rgba(255, 255, 255, 0.4));
      }
      .mannequin-slot-body {
        top: 25%;
        left: 18%;
        width: 64%;
        height: 35%;
        z-index: 3;
      }
      .mannequin-slot-neck {
        top: 24%;
        left: 35%;
        width: 30%;
        height: 18%;
        z-index: 4;
      }
      .mannequin-slot-face {
        top: 8%;
        left: 30%;
        width: 40%;
        height: 18%;
        z-index: 5;
      }
      .mannequin-slot-head {
        top: -1%;
        left: 23%;
        width: 54%;
        height: 24%;
        z-index: 6;
      }
      .mannequin-slot-companion {
        right: -4%;
        bottom: 20%;
        width: 30%;
        height: 24%;
        z-index: 7;
      }
      .figure-notes {
        display: grid;
        gap: 10px;
        padding: 16px 18px;
        border-radius: 24px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(255, 255, 255, 0.42)),
          rgba(255, 255, 255, 0.24);
        box-shadow: 0 16px 32px rgba(34, 21, 15, 0.07);
      }
      .figure-note-row {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        padding-bottom: 10px;
        border-bottom: 1px solid rgba(29, 25, 20, 0.08);
      }
      .figure-note-row:last-child {
        padding-bottom: 0;
        border-bottom: 0;
      }
      .figure-note-row strong {
        font-weight: 700;
      }
      .loadout-grid {
        display: grid;
        gap: 12px;
      }
      .slot-tile {
        display: grid;
        grid-template-columns: 78px minmax(0, 1fr);
        gap: 14px;
        align-items: center;
        width: 100%;
        padding: 12px;
        border-radius: 24px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background: rgba(255, 255, 255, 0.62);
        text-align: left;
        cursor: pointer;
        opacity: 0;
        animation: riseIn 540ms var(--ease-standard) forwards;
        transition:
          transform 180ms var(--ease-standard),
          border-color 180ms var(--ease-standard),
          box-shadow 180ms var(--ease-standard);
      }
      .slot-tile:hover {
        border-color: rgba(166, 77, 121, 0.2);
        box-shadow: 0 22px 40px rgba(42, 25, 18, 0.1);
      }
      .slot-tile.is-empty {
        cursor: default;
      }
      .slot-preview {
        width: 78px;
        height: 78px;
        border-radius: 18px;
        overflow: hidden;
        position: relative;
        isolation: isolate;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.12), transparent 30%),
          linear-gradient(180deg, rgba(33, 30, 31, 0.9), rgba(17, 19, 25, 0.96));
      }
      .slot-label {
        color: rgba(29, 25, 20, 0.45);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .slot-name {
        margin-top: 6px;
        font-size: 1.04rem;
        line-height: 1.2;
        font-weight: 700;
      }
      .wishboard {
        margin-top: 26px;
      }
      .wish-layout {
        display: grid;
        grid-template-columns: minmax(320px, 0.78fr) minmax(0, 1.22fr);
        gap: 24px;
        margin-top: 24px;
      }
      .wish-form {
        padding: 20px;
        border-radius: 28px;
        background: rgba(255, 255, 255, 0.6);
        border: 1px solid rgba(29, 25, 20, 0.08);
        box-shadow: 0 18px 36px rgba(31, 20, 13, 0.08);
      }
      .wish-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 18px;
      }
      .wish-stack {
        display: grid;
        gap: 14px;
      }
      .wish-card {
        display: grid;
        gap: 14px;
        padding: 18px;
        border-radius: 26px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.9), rgba(255, 255, 255, 0.56)),
          linear-gradient(135deg, rgba(215, 122, 40, 0.05), rgba(166, 77, 121, 0.04));
        box-shadow: 0 18px 34px rgba(31, 20, 13, 0.08);
      }
      .wish-card.is-granted {
        background:
          linear-gradient(180deg, rgba(255, 251, 244, 0.92), rgba(255, 246, 238, 0.58)),
          linear-gradient(135deg, rgba(80, 101, 63, 0.08), rgba(166, 77, 121, 0.04));
      }
      .wish-topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .wish-title {
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 1.46rem;
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      .wish-note {
        margin-top: 2px;
      }
      .collection {
        margin-top: 26px;
      }
      .bazaar {
        margin-top: 26px;
        padding: 26px;
        border-radius: 32px;
      }
      .bazaar-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
      }
      .wallet-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        min-height: 34px;
        padding: 0 12px;
        border-radius: 999px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.82), rgba(255, 255, 255, 0.44)),
          rgba(255, 255, 255, 0.2);
        border: 1px solid rgba(29, 25, 20, 0.08);
        box-shadow: 0 12px 24px rgba(35, 21, 15, 0.08);
        color: rgba(29, 25, 20, 0.76);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .wallet-pill strong {
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 1.05rem;
        letter-spacing: -0.03em;
        text-transform: none;
      }
      .bazaar-layout {
        display: grid;
        grid-template-columns: minmax(320px, 0.84fr) minmax(0, 1.16fr);
        gap: 22px;
        margin-top: 24px;
      }
      .market-form,
      .listing-card,
      .sale-card {
        border-radius: 28px;
        border: 1px solid rgba(29, 25, 20, 0.08);
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.84), rgba(255, 255, 255, 0.48)),
          rgba(255, 255, 255, 0.22);
        box-shadow: 0 18px 34px rgba(31, 20, 13, 0.08);
      }
      .market-form {
        display: grid;
        gap: 14px;
        padding: 18px;
      }
      .market-selection {
        display: grid;
        grid-template-columns: 104px minmax(0, 1fr);
        gap: 14px;
        align-items: center;
      }
      .market-selection-figure {
        width: 104px;
        height: 104px;
        border-radius: 24px;
        overflow: hidden;
        padding: 10px 10px 36px;
        position: relative;
        isolation: isolate;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.12), transparent 30%),
          linear-gradient(180deg, rgba(33, 30, 31, 0.9), rgba(17, 19, 25, 0.96));
      }
      .market-stack {
        display: grid;
        gap: 14px;
      }
      .market-columns {
        display: grid;
        gap: 18px;
      }
      .listing-card,
      .sale-card {
        display: grid;
        gap: 14px;
        padding: 16px;
      }
      .listing-card.is-own {
        border-color: rgba(166, 77, 121, 0.18);
      }
      .listing-topline {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .listing-body {
        display: grid;
        grid-template-columns: 88px minmax(0, 1fr);
        gap: 14px;
      }
      .listing-figure {
        width: 88px;
        height: 88px;
        border-radius: 22px;
        overflow: hidden;
        padding: 8px;
        position: relative;
        isolation: isolate;
        background:
          radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.12), transparent 30%),
          linear-gradient(180deg, rgba(33, 30, 31, 0.9), rgba(17, 19, 25, 0.96));
      }
      .price-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
        padding: 0 10px;
        border-radius: 999px;
        background: rgba(29, 25, 20, 0.06);
        color: rgba(29, 25, 20, 0.78);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }
      .price-pill strong {
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 1rem;
        letter-spacing: -0.03em;
        text-transform: none;
      }
      .listing-name {
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 1.34rem;
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      .sale-card {
        gap: 10px;
      }
      .filter-row {
        align-items: center;
        justify-content: flex-end;
      }
      .filter-row select {
        width: auto;
        min-width: 130px;
        border-radius: 999px;
        padding-right: 34px;
      }
      .asset-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 18px;
        margin-top: 24px;
      }
      .asset-card {
        display: grid;
        gap: 14px;
        padding: 18px;
        border-radius: 26px;
        background:
          linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(255, 255, 255, 0.58)),
          linear-gradient(135deg, rgba(215, 122, 40, 0.06), rgba(166, 77, 121, 0.04));
        border: 1px solid rgba(29, 25, 20, 0.08);
        box-shadow: 0 16px 32px rgba(32, 20, 15, 0.06);
        opacity: 0;
        animation: riseIn 580ms var(--ease-standard) forwards;
        transition:
          transform 220ms var(--ease-standard),
          box-shadow 220ms var(--ease-standard),
          border-color 220ms var(--ease-standard);
      }
      .asset-card:hover {
        box-shadow: 0 22px 44px rgba(32, 20, 15, 0.1);
      }
      .asset-card.is-equipped {
        border-color: rgba(166, 77, 121, 0.26);
      }
      .asset-card.is-selected {
        border-color: rgba(215, 122, 40, 0.32);
        box-shadow: 0 24px 50px rgba(215, 122, 40, 0.14);
      }
      .asset-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
      }
      .status-pill {
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }
      .status-pill::before {
        content: "";
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: rgba(29, 25, 20, 0.22);
      }
      .status-pill.is-active::before {
        background: linear-gradient(135deg, var(--amber), var(--rose));
      }
      .asset-figure-button {
        appearance: none;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: pointer;
        text-align: left;
      }
      .asset-figure {
        width: 100%;
        aspect-ratio: 1 / 1;
        border-radius: 24px;
        overflow: hidden;
        position: relative;
        isolation: isolate;
        padding: 12px 12px 44px;
        background:
          radial-gradient(circle at 32% 24%, rgba(255, 255, 255, 0.12), transparent 30%),
          radial-gradient(circle at 70% 74%, rgba(255, 189, 102, 0.14), transparent 34%),
          linear-gradient(180deg, rgba(29, 26, 28, 0.92), rgba(15, 17, 24, 0.98));
        box-shadow:
          inset 0 1px 0 rgba(255, 255, 255, 0.08),
          0 18px 34px rgba(28, 18, 13, 0.12);
      }
      .asset-name {
        font-family: "Iowan Old Style", "Palatino Linotype", serif;
        font-size: 1.28rem;
        line-height: 1.04;
        letter-spacing: -0.03em;
      }
      .asset-actions {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      .empty-state {
        padding: 28px;
        border-radius: 28px;
        border: 1px dashed rgba(29, 25, 20, 0.12);
        background: rgba(255, 255, 255, 0.56);
      }
      .empty-state.compact {
        padding: 18px;
        border-radius: 22px;
      }
      .toast {
        position: fixed;
        right: 24px;
        bottom: 24px;
        padding: 14px 16px;
        border-radius: 18px;
        background: rgba(24, 18, 14, 0.94);
        color: #fdf6ee;
        box-shadow: 0 24px 48px rgba(22, 16, 12, 0.22);
        opacity: 0;
        transform: translateY(10px);
        transition:
          opacity 180ms var(--ease-standard),
          transform 180ms var(--ease-standard);
        pointer-events: none;
        font-size: 13px;
        font-weight: 700;
        line-height: 1.4;
      }
      .toast.is-visible {
        opacity: 1;
        transform: translateY(0);
      }
      @keyframes riseIn {
        from {
          opacity: 0;
          translate: 0 14px;
        }
        to {
          opacity: 1;
          translate: 0 0;
        }
      }
      @keyframes breathe {
        0%,
        100% {
          translate: 0 0;
          scale: 1;
        }
        50% {
          translate: 0 -4px;
          scale: 1.01;
        }
      }
      @media (max-width: 1180px) {
        .hero,
        .showcase-grid,
        .stage-layout,
        .wish-layout,
        .bazaar-layout,
        .wish-columns,
        .spotlight-body {
          grid-template-columns: 1fr;
        }
        .stat-rail {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .filter-row {
          justify-content: flex-start;
        }
        .veil-aurora-a,
        .veil-aurora-b,
        .veil-halo {
          width: 62vw;
          height: 62vw;
        }
      }
      @media (max-width: 760px) {
        .shell {
          width: min(100vw - 20px, 1420px);
          padding-top: 12px;
        }
        .hero-copy,
        .hero-tools,
        .stage,
        .wishboard,
        .collection,
        .spotlight-copy-block {
          padding: 20px;
        }
        .mannequin-stage {
          min-height: 520px;
          padding: 18px;
        }
        .stat-rail,
        .field-grid {
          grid-template-columns: 1fr;
        }
        .inventory-row {
          flex-direction: column;
        }
        .veil-beam {
          display: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        html {
          scroll-behavior: auto;
        }
        #veil-webgl {
          display: none;
        }
        *,
        *::before,
        *::after {
          animation: none !important;
          transition: none !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="veil-scene" aria-hidden="true">
      <canvas id="veil-webgl"></canvas>
      <div class="veil-aurora veil-aurora-a"></div>
      <div class="veil-aurora veil-aurora-b"></div>
      <div class="veil-halo"></div>
      <div class="veil-beam veil-beam-a"></div>
      <div class="veil-beam veil-beam-b"></div>
    </div>

    <main class="shell">
      <section class="hero" data-depth-card data-depth-strength="9" data-depth-lift="8" data-parallax="0.12">
        <article class="hero-copy">
          <div class="eyebrow">Veil</div>
          <h1>Objects with afterlife.</h1>
          <p class="lead">
            The loop is simple and sticky: capture something real from the page, cut it out,
            let the forge roll rarity and finish, then turn that drop into a wish fulfilled,
            a status symbol, or a piece of your bot's public identity.
          </p>
          <div id="stat-rail" class="stat-rail"></div>
        </article>
        <aside class="hero-tools">
          <div>
            <p class="tools-label">Entry</p>
            <p id="inventory-label" class="meta-text">Loading <strong>${escapedInventoryKey}</strong>...</p>
          </div>
          <form class="inventory-form" id="inventory-form">
            <label for="inventory-key">Entry key</label>
            <div class="inventory-row">
              <input id="inventory-key" name="inventoryKey" value="${escapedInventoryKey}" />
              <button type="submit" class="primary-button">Enter</button>
            </div>
          </form>
          <div class="link-row">
            <a class="ghost-link" href="/plugins/wig-forge/inventory?inventoryKey=${encodeURIComponent(params.inventoryKey)}">View JSON</a>
            <a class="ghost-link" href="/plugins/wig-forge/health">Plugin Health</a>
          </div>
          <p class="meta-text">
            Best when paired with the browser extension: capture in-page objects, mint them into drops,
            then return here to spotlight, equip, wish, and grant.
          </p>
        </aside>
      </section>

      <section class="showcase-grid">
        <article class="spotlight" data-depth-card data-depth-strength="10" data-depth-lift="10" data-parallax="0.18">
          <div id="spotlight-panel" class="spotlight-body"></div>
        </article>

        <article class="stage" data-depth-card data-depth-strength="8" data-depth-lift="8" data-parallax="0.09">
          <div class="stage-head">
            <div>
              <div class="eyebrow">Figure</div>
              <h2 class="section-title">What has settled into form.</h2>
              <p class="section-copy">
                Empty slots stay visible on purpose, so the room always implies the next reward.
              </p>
            </div>
            <div id="loadout-meta" class="collection-meta"></div>
          </div>
          <div class="stage-layout">
            <div id="figure-scene" class="figure-scene"></div>
            <div id="loadout-grid" class="loadout-grid"></div>
          </div>
        </article>
      </section>

      <section class="wishboard" data-depth-card data-depth-strength="8" data-depth-lift="8" data-parallax="0.11">
        <div class="wish-head">
          <div>
            <div class="eyebrow">Pulse</div>
            <h2 class="section-title">What still asks to be answered.</h2>
            <p class="section-copy">
              Wishes turn vague wanting into a concrete reward contract: the bot can long for a hat,
              companion, tie, aura, or any other owned thing you are willing to grant after real work.
            </p>
          </div>
          <div id="wish-meta" class="collection-meta"></div>
        </div>
        <div class="wish-layout">
          <form id="wish-form" class="wish-form" data-depth-card data-depth-strength="7" data-depth-lift="6">
            <div class="field">
              <label for="wish-title">Wish title</label>
              <input id="wish-title" name="title" maxlength="80" placeholder="Solar ribbon hat" required />
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="wish-slot">Slot</label>
                <select id="wish-slot" name="slot" required>
                  ${slotOptionsHtml}
                </select>
              </div>
              <div class="field">
                <label for="wish-rarity">Desired rarity</label>
                <select id="wish-rarity" name="desiredRarity">
                  <option value="any">any</option>
                  ${rarityOptionsHtml}
                </select>
              </div>
            </div>
            <div class="field-grid">
              <div class="field">
                <label for="wish-requested-by">Voice</label>
                <input id="wish-requested-by" name="requestedBy" maxlength="60" placeholder="openclaw-bot" />
              </div>
              <div class="field">
                <label for="wish-style-tags">Style tags</label>
                <input id="wish-style-tags" name="styleTags" maxlength="120" placeholder="silk, formal, bright" />
              </div>
            </div>
            <div class="field">
              <label for="wish-note">Note</label>
              <textarea id="wish-note" name="note" maxlength="220" placeholder="Something celebratory enough to wear after a flawless run."></textarea>
            </div>
            <div class="action-row">
              <button type="submit" class="primary-button">Pin</button>
            </div>
          </form>

          <div class="wish-columns">
            <section>
              <div class="tools-label">Pinned</div>
              <div id="active-wishes" class="wish-stack"></div>
            </section>
            <section>
              <div class="tools-label">Bestowed</div>
              <div id="granted-wishes" class="wish-stack"></div>
            </section>
          </div>
        </div>
      </section>

      <section class="collection" data-depth-card data-depth-strength="8" data-depth-lift="8" data-parallax="0.07">
        <div class="collection-head">
          <div>
            <div class="eyebrow">Trace</div>
            <h2 class="section-title">Fragments, editions, near-myths.</h2>
          </div>
          <div class="filter-row">
            <select id="slot-filter" aria-label="Filter by slot">
              <option value="all">All slots</option>
              ${slotOptionsHtml}
            </select>
            <select id="rarity-filter" aria-label="Filter by rarity">
              <option value="all">All rarities</option>
              ${rarityOptionsHtml}
            </select>
            <select id="ownership-filter" aria-label="Filter by state">
              <option value="all">All states</option>
              <option value="equipped">Applied only</option>
              <option value="available">Unapplied only</option>
            </select>
          </div>
        </div>
        <div id="collection-meta" class="collection-meta"></div>
        <div id="asset-grid" class="asset-grid"></div>
      </section>

      <section class="bazaar" data-depth-card data-depth-strength="8" data-depth-lift="8" data-parallax="0.1">
        <div class="bazaar-head">
          <div>
            <div class="eyebrow">Bazaar</div>
            <h2 class="section-title">Where drops turn into wig.</h2>
            <p class="section-copy">
              Put a held piece into circulation, earn wig when another room buys it, and use that balance
              to acquire rare fragments your own bot wants to wear.
            </p>
          </div>
          <div id="wallet-pill" class="wallet-pill">wig <strong>0</strong></div>
        </div>
        <div class="bazaar-layout">
          <form id="market-form" class="market-form" data-depth-card data-depth-strength="7" data-depth-lift="6"></form>
          <div class="market-columns">
            <section>
              <div class="tools-label">Open Bazaar</div>
              <div id="market-active" class="market-stack"></div>
            </section>
            <section>
              <div class="tools-label">Recent Sales</div>
              <div id="market-history" class="market-stack"></div>
            </section>
          </div>
        </div>
      </section>
    </main>

    <div id="toast" class="toast" aria-live="polite"></div>

    <script>
      const ROUTE_PREFIX = "/plugins/wig-forge";
      const INITIAL_INVENTORY_KEY = ${JSON.stringify(params.inventoryKey)};
      const SLOT_ORDER = ${slotsJson};
      const RARITY_ORDER = ${rarityOrderJson};
      const RARITY_RANK = Object.fromEntries(
        RARITY_ORDER.map((rarity, index) => [rarity, RARITY_ORDER.length - index]),
      );
      const motionPreference =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)")
          : { matches: false };

      const state = {
        inventoryKey: INITIAL_INVENTORY_KEY,
        inventory: null,
        wishes: null,
        market: null,
        loading: false,
        selectedAssetId: null,
        filters: {
          slot: "all",
          rarity: "all",
          ownership: "all",
        },
      };

      const statRail = document.querySelector("#stat-rail");
      const inventoryForm = document.querySelector("#inventory-form");
      const inventoryInput = document.querySelector("#inventory-key");
      const inventoryLabel = document.querySelector("#inventory-label");
      const spotlightPanel = document.querySelector("#spotlight-panel");
      const loadoutMeta = document.querySelector("#loadout-meta");
      const figureScene = document.querySelector("#figure-scene");
      const loadoutGrid = document.querySelector("#loadout-grid");
      const wishMeta = document.querySelector("#wish-meta");
      const wishForm = document.querySelector("#wish-form");
      const activeWishes = document.querySelector("#active-wishes");
      const grantedWishes = document.querySelector("#granted-wishes");
      const collectionMeta = document.querySelector("#collection-meta");
      const assetGrid = document.querySelector("#asset-grid");
      const walletPill = document.querySelector("#wallet-pill");
      const marketForm = document.querySelector("#market-form");
      const marketActive = document.querySelector("#market-active");
      const marketHistory = document.querySelector("#market-history");
      const slotFilter = document.querySelector("#slot-filter");
      const rarityFilter = document.querySelector("#rarity-filter");
      const ownershipFilter = document.querySelector("#ownership-filter");
      const toast = document.querySelector("#toast");
      const rootStyle = document.documentElement;
      const webglCanvas = document.querySelector("#veil-webgl");
      const hoverPreference =
        typeof window.matchMedia === "function"
          ? window.matchMedia("(hover: hover) and (pointer: fine)")
          : { matches: true };

      const sceneState = {
        parallaxNodes: [],
        parallaxFrame: 0,
        webglScene: null,
      };

      initializeSpatialScene();

      inventoryForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        const nextKey = (inventoryInput?.value || "").trim() || "default-web";
        const url = new URL(window.location.href);
        url.searchParams.set("inventoryKey", nextKey);
        window.location.href = url.toString();
      });

      wishForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!(form instanceof HTMLFormElement)) {
          return;
        }
        const formData = new FormData(form);
        const payload = {
          title: String(formData.get("title") || "").trim(),
          slot: String(formData.get("slot") || "").trim(),
          desiredRarity: String(formData.get("desiredRarity") || "any").trim() || "any",
          requestedBy: String(formData.get("requestedBy") || "").trim(),
          styleTags: parseStyleTags(String(formData.get("styleTags") || "")),
          note: String(formData.get("note") || "").trim(),
        };
        try {
          await createWish(payload);
          form.reset();
          const rarityField = form.querySelector("#wish-rarity");
          if (rarityField instanceof HTMLSelectElement) {
            rarityField.value = "any";
          }
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error));
        }
      });

      marketForm?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!(form instanceof HTMLFormElement)) {
          return;
        }
        const selectedAsset = getSelectedAsset();
        if (!selectedAsset) {
          showToast("Select an asset before listing it.");
          return;
        }
        const formData = new FormData(form);
        try {
          await listSelectedAsset({
            assetId: selectedAsset.id,
            priceWig: Number(formData.get("priceWig")),
            note: String(formData.get("note") || ""),
          });
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error));
        }
      });

      slotFilter?.addEventListener("change", () => {
        state.filters.slot = slotFilter.value;
        renderAssets();
      });

      rarityFilter?.addEventListener("change", () => {
        state.filters.rarity = rarityFilter.value;
        renderAssets();
      });

      ownershipFilter?.addEventListener("change", () => {
        state.filters.ownership = ownershipFilter.value;
        renderAssets();
      });

      loadRoomData().catch((error) => {
        state.loading = false;
        render();
        showToast(error instanceof Error ? error.message : String(error));
      });

      async function loadRoomData(options = {}) {
        const preserveSelection = options.preserveSelection !== false;
        state.loading = true;
        render();

        const [inventoryResponse, wishesResponse, marketResponse] = await Promise.all([
          fetch(inventoryUrl(state.inventoryKey), {
            headers: { "X-Wig-Forge-Client": "collection-room" },
          }),
          fetch(wishesUrl(state.inventoryKey), {
            headers: { "X-Wig-Forge-Client": "collection-room" },
          }),
          fetch(marketUrl(state.inventoryKey), {
            headers: { "X-Wig-Forge-Client": "collection-room" },
          }),
        ]);

        const [inventoryData, wishesData, marketData] = await Promise.all([
          inventoryResponse.json(),
          wishesResponse.json(),
          marketResponse.json(),
        ]);

        if (!inventoryResponse.ok) {
          throw new Error(inventoryData?.error || "Could not load collection room inventory.");
        }
        if (!wishesResponse.ok) {
          throw new Error(wishesData?.error || "Could not load wishes.");
        }
        if (!marketResponse.ok) {
          throw new Error(marketData?.error || "Could not load bazaar listings.");
        }

        runTransition(() => {
          state.inventory = inventoryData.inventory;
          state.wishes = wishesData.wishes;
          state.market = {
            market: marketData.market,
            activeListings: marketData.activeListings || [],
            ownListings: marketData.ownListings || [],
            recentSales: marketData.recentSales || [],
            wallet: marketData.wallet || inventoryData.inventory?.wallet || null,
          };
          state.loading = false;

          const availableIds = new Set((state.inventory?.assets || []).map((asset) => asset.id));
          if (!preserveSelection || !state.selectedAssetId || !availableIds.has(state.selectedAssetId)) {
            state.selectedAssetId = pickDefaultAsset(state.inventory)?.id || null;
          }

          render();
        });
      }

      async function equipAsset(assetId) {
        const response = await fetch(\`\${ROUTE_PREFIX}/equip\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            assetId,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not equip the asset.");
        }

        runTransition(() => {
          state.inventory = data.inventory;
          state.selectedAssetId = assetId;
          render();
        });

        showToast(\`\${data.asset.name} applied to \${data.asset.slot}.\`);
      }

      async function createWish(payload) {
        const response = await fetch(\`\${ROUTE_PREFIX}/wishes\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            ...payload,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not record the wish.");
        }

        runTransition(() => {
          state.wishes = data.wishes;
          render();
        });

        showToast(\`Pinned \${data.wish.title}.\`);
      }

      async function grantWish(wishId, assetId) {
        const response = await fetch(\`\${ROUTE_PREFIX}/grant\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            wishId,
            assetId,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not grant the wish.");
        }

        runTransition(() => {
          state.inventory = data.inventory;
          state.wishes = data.wishes;
          state.selectedAssetId = assetId;
          render();
        });

        showToast(\`Bestowed \${data.wish.title} through \${data.asset.name}.\`);
      }

      function render() {
        renderStats();
        renderSpotlight();
        renderLoadout();
        renderWishes();
        renderAssets();
        renderBazaar();

        inventoryLabel.innerHTML = state.loading
          ? \`Loading <strong>\${escapeHtml(state.inventoryKey)}</strong>...\`
          : \`Entry key <strong>\${escapeHtml(state.inventoryKey)}</strong>\`;
        refreshSpatialTargets();
      }

      function renderStats() {
        if (!state.inventory) {
          statRail.innerHTML = buildStatTiles([
            { label: "Trace", value: "0", note: "Waiting for capture" },
            { label: "Form", value: "0", note: "Slots are empty" },
            { label: "Pulse", value: "0", note: "No pull yet" },
            { label: "Wig", value: "0", note: "No buying power yet" },
          ]);
          return;
        }

        const inventory = state.inventory;
        const wishes = state.wishes?.wishes || [];
        const activeCount = wishes.filter((wish) => wish.status === "active").length;
        const equippedCount = Object.values(inventory.loadout || {}).filter(Boolean).length;
        const wigBalance = inventory.wallet?.wigBalance ?? 0;

        statRail.innerHTML = buildStatTiles([
          {
            label: "Trace",
            value: String(inventory.assets.length),
            note: "Drops in the room",
          },
          {
            label: "Form",
            value: String(equippedCount),
            note: \`of \${SLOT_ORDER.length} live slots\`,
          },
          {
            label: "Pulse",
            value: String(activeCount),
            note: activeCount ? "Still waiting on an answer" : "Pulse is quiet",
          },
          {
            label: "Wig",
            value: String(wigBalance),
            note: wigBalance ? "Ready for the bazaar" : "Spend or earn through trade",
          },
        ]);
      }

      function renderSpotlight() {
        const inventory = state.inventory;
        const wishes = state.wishes?.wishes || [];

        if (!inventory || inventory.assets.length === 0) {
          spotlightPanel.innerHTML = \`
            <div class="spotlight-body">
              <div class="spotlight-canvas">
                <div class="empty-state">
                  <div class="eyebrow">No Glint Yet</div>
                  <h2 class="section-title">Forge a page object into the first drop.</h2>
                  <p class="empty-copy" style="margin-top:12px;max-width:30rem;">
                    Use the browser extension, hover an object on the page, capture it, then let the forge
                    roll rarity, trim, palette, and slot. The freshest result always takes the spotlight here.
                  </p>
                </div>
              </div>
              <div class="spotlight-copy-block">
                <div>
                  <div class="eyebrow">Glint</div>
                  <h2 class="section-title">The first shimmer has not arrived.</h2>
                  <p class="section-copy">
                    The fastest route to habit is a strong reveal moment, not a buried spreadsheet of items.
                  </p>
                </div>
              </div>
            </div>
          \`;
          return;
        }

        const asset =
          inventory.assets.find((entry) => entry.id === state.selectedAssetId) || pickDefaultAsset(inventory);

        if (!asset) {
          spotlightPanel.innerHTML = "";
          return;
        }

        const latestAsset = pickDefaultAsset(inventory);
        const isEquipped = inventory.loadout?.[asset.slot] === asset.id;
        const matchingWishes = wishes.filter((wish) => wish.status === "active" && wish.slot === asset.slot);
        const score =
          typeof asset.score?.finalScore === "number" ? Math.round(asset.score.finalScore * 100) : null;
        const estimatedWig = estimateListingPrice(asset);
        const botAppeal = estimateBotAppeal(asset);
        const tags = formatTags(asset.styleTags);
        const transitionName = transitionNameFor(asset.id);

        spotlightPanel.innerHTML = \`
          <div class="spotlight-canvas">
            \${renderArtifactDisplay(asset, inventory.updatedAt, {
              className: "spotlight-figure",
              attributes: 'data-depth-card data-depth-strength="12" data-depth-lift="10"',
              transitionName,
              footerLeft: asset.files?.svgPath ? "vector finish" : "sprite finish",
              footerRight: \`~ \${estimatedWig} wig\`,
            })}
          </div>
          <div class="spotlight-copy-block">
            <div>
              <div class="eyebrow">\${asset.id === latestAsset?.id ? "Glint" : "In View"}</div>
              <h2 class="section-title">\${escapeHtml(asset.name)}</h2>
              <p class="section-copy" style="margin-top:12px;">
                \${score !== null ? \`Forge score \${score}.\` : "Fresh from the forge."}
                \${matchingWishes.length ? \` Fits \${matchingWishes.length} active wish\${matchingWishes.length === 1 ? "" : "es"} in the \${escapeHtml(asset.slot)} slot.\` : " Ready to become a gift, display piece, or immediate equip."}
              </p>
            </div>

            <div class="badge-row">
              <span class="badge rarity-\${escapeHtml(asset.rarity)}">\${escapeHtml(asset.rarity)}</span>
              <span class="badge">\${escapeHtml(asset.slot)}</span>
              <span class="badge">\${escapeHtml(asset.visuals?.material || "crafted")}</span>
            </div>

            <div class="signal-row">
              <span class="signal-pill">~ \${escapeHtml(String(estimatedWig))} wig</span>
              <span class="signal-pill">OpenClaw pull \${escapeHtml(String(botAppeal))}% · \${escapeHtml(describeBotAppeal(botAppeal))}</span>
            </div>

            <div class="detail-grid">
              <div class="detail-row">
                <span class="meta-text">Trim</span>
                <strong>\${escapeHtml(asset.visuals?.trim || "trimmed")}</strong>
              </div>
              <div class="detail-row">
                <span class="meta-text">Forged</span>
                <strong>\${escapeHtml(formatDate(asset.createdAt))}</strong>
              </div>
              <div class="detail-row">
                <span class="meta-text">Wish fit</span>
                <strong>\${matchingWishes.length ? \`\${matchingWishes.length} active\` : "none yet"}</strong>
              </div>
            </div>

            <div class="palette-row">\${renderPalette(asset.palette)}</div>

            <p class="asset-tags">\${tags}</p>

            <div class="action-row">
              <button
                type="button"
                class="primary-button"
                data-role="spotlight-equip"
                data-asset-id="\${escapeHtml(asset.id)}"
                \${isEquipped ? "disabled" : ""}
              >
                \${isEquipped ? "Applied" : "Apply"}
              </button>
              <a class="ghost-link" href="\${assetImageUrl(asset.id, "source", inventory.updatedAt)}" target="_blank" rel="noreferrer">
                Origin
              </a>
              \${asset.files?.svgPath ? \`<a class="ghost-link" href="\${assetImageUrl(asset.id, "vector", inventory.updatedAt)}" target="_blank" rel="noreferrer">Vector</a>\` : ""}
            </div>
          </div>
        \`;

        spotlightPanel.querySelectorAll("[data-role='spotlight-equip']").forEach((button) => {
          button.addEventListener("click", async () => {
            const assetId = button.getAttribute("data-asset-id");
            if (!assetId) {
              return;
            }
            button.setAttribute("disabled", "disabled");
            try {
              await equipAsset(assetId);
            } catch (error) {
              button.removeAttribute("disabled");
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      function renderLoadout() {
        const inventory = state.inventory;

        if (!inventory) {
          loadoutMeta.textContent = "Awaiting figure";
          figureScene.innerHTML = buildLoadingFigureScene();
          loadoutGrid.innerHTML = buildLoadingTiles();
          return;
        }

        const assetsById = new Map((inventory.assets || []).map((asset) => [asset.id, asset]));
        const equippedCount = Object.values(inventory.loadout || {}).filter(Boolean).length;

        loadoutMeta.textContent = \`\${equippedCount} of \${SLOT_ORDER.length} slots equipped\`;
        figureScene.innerHTML = buildFigureScene(inventory, assetsById);
        loadoutGrid.innerHTML = SLOT_ORDER.map((slot, index) => {
          const assetId = inventory.loadout?.[slot] || null;
          const asset = assetId ? assetsById.get(assetId) : null;
          return \`
            <button
              type="button"
              class="slot-tile \${asset ? "" : "is-empty"}"
              style="animation-delay:\${index * 42}ms"
              data-depth-card
              data-depth-strength="7"
              data-depth-lift="6"
              \${asset ? \`data-role="focus-loadout" data-asset-id="\${escapeHtml(asset.id)}"\` : "disabled"}
            >
              \${asset ? renderArtifactDisplay(asset, inventory.updatedAt, { className: "slot-preview" }) : '<div class="slot-preview"></div>'}
              <div>
                <div class="slot-label">\${escapeHtml(slot)}</div>
                <div class="slot-name">\${asset ? escapeHtml(asset.name) : "Unheld slot"}</div>
                <div class="meta-text" style="margin-top:4px;">
                  \${asset ? \`\${escapeHtml(asset.rarity)} · \${escapeHtml(asset.visuals?.material || "crafted")}\` : "Still waiting for something worth holding."}
                </div>
              </div>
            </button>
          \`;
        }).join("");

        loadoutGrid.querySelectorAll("[data-role='focus-loadout']").forEach((button) => {
          button.addEventListener("click", () => {
            const assetId = button.getAttribute("data-asset-id");
            if (!assetId) {
              return;
            }
            focusAsset(assetId);
          });
        });

        figureScene.querySelectorAll("[data-role='focus-worn']").forEach((button) => {
          button.addEventListener("click", () => {
            const assetId = button.getAttribute("data-asset-id");
            if (!assetId) {
              return;
            }
            focusAsset(assetId);
          });
        });
      }

      function renderWishes() {
        const inventory = state.inventory;
        const wishDoc = state.wishes;

        if (!wishDoc) {
          wishMeta.textContent = "Awaiting pulse";
          activeWishes.innerHTML = buildLoadingWishCards();
          grantedWishes.innerHTML = buildLoadingWishCards();
          return;
        }

        const wishes = wishDoc.wishes || [];
        const active = wishes
          .filter((wish) => wish.status === "active")
          .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
        const granted = wishes
          .filter((wish) => wish.status === "granted")
          .sort((left, right) => String(right.grantedAt || "").localeCompare(String(left.grantedAt || "")));

        wishMeta.textContent = \`\${active.length} pinned · \${granted.length} bestowed\`;

        if (!active.length) {
          activeWishes.innerHTML = \`
            <div class="empty-state compact">
              <div class="eyebrow">No Pulse</div>
              <p class="empty-copy" style="margin-top:10px;">
                Record a concrete desire so the bot learns what counts as a meaningful reward.
              </p>
            </div>
          \`;
        } else {
          activeWishes.innerHTML = active.map((wish) => {
            const matches = compatibleAssets(inventory, wish);
            const idealMatchCount = matches.filter((asset) => matchesDesiredRarity(asset, wish)).length;
            return \`
              <article class="wish-card" data-depth-card data-depth-strength="7" data-depth-lift="6">
                <div class="wish-topline">
                  <div>
                    <div class="badge-row">
                      <span class="badge">\${escapeHtml(wish.slot)}</span>
                      \${wish.desiredRarity ? \`<span class="badge rarity-\${escapeHtml(wish.desiredRarity)}">\${escapeHtml(wish.desiredRarity)}</span>\` : ""}
                    </div>
                    <h3 class="wish-title" style="margin-top:10px;">\${escapeHtml(wish.title)}</h3>
                  </div>
                  <div class="status-pill is-active">Pinned</div>
                </div>
                <div>
                  <p class="wish-note">\${escapeHtml(wish.note || "Waiting for the right item to be gifted.")}</p>
                  <p class="match-meta" style="margin-top:8px;">
                    \${wish.requestedBy ? \`Voiced by \${escapeHtml(wish.requestedBy)}.\` : "Pinned in Veil."}
                    \${matches.length ? \` \${matches.length} owned piece\${matches.length === 1 ? "" : "s"} fit this slot\${idealMatchCount ? \`; \${idealMatchCount} hit the target rarity\` : ""}.\` : " No owned piece fits yet."}
                  </p>
                </div>
                <p class="asset-tags">\${formatTags(wish.styleTags)}</p>
                \${matches.length ? \`
                  <div class="wish-grant-row">
                    <select id="grant-\${escapeHtml(wish.id)}" data-role="wish-asset-select" data-wish-id="\${escapeHtml(wish.id)}">
                      \${matches.map((asset) => \`
                        <option value="\${escapeHtml(asset.id)}">
                          \${escapeHtml(asset.name)} · \${escapeHtml(asset.rarity)}\${matchesDesiredRarity(asset, wish) ? " · ideal" : ""}
                        </option>
                      \`).join("")}
                    </select>
                    <button type="button" class="primary-button" data-role="grant-wish" data-wish-id="\${escapeHtml(wish.id)}">
                      Bestow
                    </button>
                  </div>
                \` : \`
                  <div class="empty-state compact">
                    <p class="empty-copy">Forge or buy something for the \${escapeHtml(wish.slot)} slot first.</p>
                  </div>
                \`}
              </article>
            \`;
          }).join("");
        }

        if (!granted.length) {
          grantedWishes.innerHTML = \`
            <div class="empty-state compact">
              <div class="eyebrow">No Bestowal Yet</div>
              <p class="empty-copy" style="margin-top:10px;">
                The best part of the loop is when a real item crosses from collection into ownership.
              </p>
            </div>
          \`;
        } else {
          const assetsById = new Map((inventory?.assets || []).map((asset) => [asset.id, asset]));
          grantedWishes.innerHTML = granted.map((wish) => {
            const grantedAsset = wish.grantedAssetId ? assetsById.get(wish.grantedAssetId) : null;
            return \`
              <article class="wish-card is-granted" data-depth-card data-depth-strength="7" data-depth-lift="6">
                <div class="wish-topline">
                  <div>
                    <div class="badge-row">
                      <span class="badge">\${escapeHtml(wish.slot)}</span>
                      <span class="badge">bestowed</span>
                    </div>
                    <h3 class="wish-title" style="margin-top:10px;">\${escapeHtml(wish.title)}</h3>
                  </div>
                  <div class="status-pill is-active">Answered</div>
                </div>
                <div>
                  <p class="wish-note">\${escapeHtml(wish.note || "Answered and folded into the bot's memory of rewards.")}</p>
                  <p class="match-meta" style="margin-top:8px;">
                    \${grantedAsset ? \`Bestowed through \${escapeHtml(grantedAsset.name)}.\` : "Bestowed from inventory."}
                    \${wish.grantedAt ? \` \${escapeHtml(formatDate(wish.grantedAt))}.\` : ""}
                  </p>
                </div>
              </article>
            \`;
          }).join("");
        }

        activeWishes.querySelectorAll("[data-role='grant-wish']").forEach((button) => {
          button.addEventListener("click", async () => {
            const wishId = button.getAttribute("data-wish-id");
            if (!wishId) {
              return;
            }
            const select = activeWishes.querySelector(\`[data-role='wish-asset-select'][data-wish-id="\${CSS.escape(wishId)}"]\`);
            const assetId = select instanceof HTMLSelectElement ? select.value : "";
            if (!assetId) {
              return;
            }
            button.setAttribute("disabled", "disabled");
            try {
              await grantWish(wishId, assetId);
            } catch (error) {
              button.removeAttribute("disabled");
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      function renderAssets() {
        const inventory = state.inventory;
        const wishes = state.wishes?.wishes || [];
        const listedAssetIds = new Set(
          getActiveListings()
            .filter((listing) => listing.sellerInventoryKey === state.inventoryKey)
            .map((listing) => listing.assetId),
        );

        if (!inventory) {
          collectionMeta.textContent = "Awaiting trace";
          assetGrid.innerHTML = \`<div class="empty-state"><p class="empty-copy">Loading trace...</p></div>\`;
          return;
        }

        const visibleAssets = applyAssetFilters(sortAssets(inventory.assets || []), inventory);
        collectionMeta.textContent = \`Showing \${visibleAssets.length} of \${inventory.assets.length} forged item\${inventory.assets.length === 1 ? "" : "s"} · updated \${formatDate(inventory.updatedAt)}\`;

        if (!visibleAssets.length) {
          assetGrid.innerHTML = \`
            <div class="empty-state">
              <div class="eyebrow">No Trace</div>
              <h3 class="section-title" style="margin-top:12px;">Try widening the room filters.</h3>
              <p class="empty-copy" style="margin-top:10px;max-width:30rem;">
                Nothing in the current collection matches this combination of slot, rarity, and ownership state.
              </p>
            </div>
          \`;
          return;
        }

        assetGrid.innerHTML = visibleAssets.map((asset, index) => {
          const isEquipped = inventory.loadout?.[asset.slot] === asset.id;
          const isSelected = state.selectedAssetId === asset.id;
          const transitionName = transitionNameFor(asset.id);
          const tags = formatTags(asset.styleTags);
          const matchingWishCount = wishes.filter((wish) => wish.status === "active" && wish.slot === asset.slot).length;
          const score =
            typeof asset.score?.finalScore === "number" ? Math.round(asset.score.finalScore * 100) : null;
          const estimatedWig = estimateListingPrice(asset);
          const botAppeal = estimateBotAppeal(asset);
          const isListed = listedAssetIds.has(asset.id);

          return \`
            <article
              id="asset-\${escapeHtml(asset.id)}"
              class="asset-card \${isEquipped ? "is-equipped" : ""} \${isSelected ? "is-selected" : ""}"
              style="animation-delay:\${Math.min(index, 8) * 48}ms"
              data-depth-card
              data-depth-strength="7"
              data-depth-lift="7"
            >
              <div class="asset-head">
                <div class="badge-row">
                  <span class="badge rarity-\${escapeHtml(asset.rarity)}">\${escapeHtml(asset.rarity)}</span>
                  <span class="badge">\${escapeHtml(asset.slot)}</span>
                </div>
                <div class="status-pill \${isEquipped || isSelected ? "is-active" : ""}">
                  \${isEquipped ? "Applied" : isSelected ? "In Glint" : "Held"}
                </div>
              </div>

              <button type="button" class="asset-figure-button" data-role="focus-asset" data-asset-id="\${escapeHtml(asset.id)}">
                \${renderArtifactDisplay(asset, inventory.updatedAt, {
                  className: "asset-figure",
                  transitionName,
                  footerLeft: asset.files?.svgPath ? "vector" : "sprite",
                  footerRight: \`pull \${botAppeal}%\`,
                })}
              </button>

              <div>
                <h3 class="asset-name">\${escapeHtml(asset.name)}</h3>
                <p class="asset-description" style="margin-top:8px;">
                  \${score !== null ? \`Forge score \${score} · \` : ""}\${escapeHtml(asset.visuals?.material || "crafted")} · \${escapeHtml(asset.visuals?.trim || "trimmed")}
                </p>
                <p class="asset-tags" style="margin-top:8px;">\${tags}</p>
                <p class="match-meta" style="margin-top:8px;">
                  \${matchingWishCount ? \`\${matchingWishCount} active wish\${matchingWishCount === 1 ? "" : "es"} fit this slot.\` : "No active wish targets this slot right now."}
                  \${isListed ? " Listed in the bazaar." : ""}
                </p>
              </div>

              <div class="signal-row">
                <span class="signal-pill">~ \${escapeHtml(String(estimatedWig))} wig</span>
                <span class="signal-pill">OpenClaw pull \${escapeHtml(String(botAppeal))}%</span>
              </div>

              <div class="asset-actions">
                <button
                  type="button"
                  class="primary-button"
                  data-role="equip"
                  data-asset-id="\${escapeHtml(asset.id)}"
                  \${isEquipped ? "disabled" : ""}
                >
                  \${isEquipped ? "Applied" : "Apply"}
                </button>
                <button type="button" class="ghost-button" data-role="focus-asset" data-asset-id="\${escapeHtml(asset.id)}">
                  \${isSelected ? "In Glint" : "Hold"}
                </button>
                <a class="ghost-link" href="\${assetImageUrl(asset.id, "source", inventory.updatedAt)}" target="_blank" rel="noreferrer">
                  Origin
                </a>
                \${asset.files?.svgPath ? \`<a class="ghost-link" href="\${assetImageUrl(asset.id, "vector", inventory.updatedAt)}" target="_blank" rel="noreferrer">Vector</a>\` : ""}
              </div>
            </article>
          \`;
        }).join("");

        assetGrid.querySelectorAll("[data-role='focus-asset']").forEach((button) => {
          button.addEventListener("click", () => {
            const assetId = button.getAttribute("data-asset-id");
            if (!assetId) {
              return;
            }
            focusAsset(assetId);
          });
        });

        assetGrid.querySelectorAll("[data-role='equip']").forEach((button) => {
          button.addEventListener("click", async () => {
            const assetId = button.getAttribute("data-asset-id");
            if (!assetId) {
              return;
            }
            button.setAttribute("disabled", "disabled");
            try {
              await equipAsset(assetId);
            } catch (error) {
              button.removeAttribute("disabled");
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        });
      }

      function renderBazaar() {
        const inventory = state.inventory;
        const market = state.market;
        const selectedAsset = getSelectedAsset();

        walletPill.innerHTML = \`wig <strong>\${escapeHtml(String(inventory?.wallet?.wigBalance ?? 0))}</strong>\`;

        if (!inventory || !market) {
          marketForm.innerHTML = \`
            <div class="empty-state compact">
              <div class="eyebrow">No Bazaar Yet</div>
              <p class="empty-copy" style="margin-top:10px;">
                The room is still loading its balance and open listings.
              </p>
            </div>
          \`;
          marketActive.innerHTML = \`<div class="empty-state compact"><p class="empty-copy">Loading listings...</p></div>\`;
          marketHistory.innerHTML = \`<div class="empty-state compact"><p class="empty-copy">Loading sales...</p></div>\`;
          return;
        }

        const selectedListing = selectedAsset ? getOwnedActiveListingForAsset(selectedAsset.id) : null;
        const selectionMarkup = selectedAsset
          ? \`
            <div class="market-selection">
              \${renderArtifactDisplay(selectedAsset, inventory.updatedAt, {
                className: "market-selection-figure",
                footerLeft: selectedAsset.files?.svgPath ? "vector" : "sprite",
                footerRight: \`~ \${estimateListingPrice(selectedAsset)} wig\`,
              })}
              <div>
                <div class="badge-row">
                  <span class="badge rarity-\${escapeHtml(selectedAsset.rarity)}">\${escapeHtml(selectedAsset.rarity)}</span>
                  <span class="badge">\${escapeHtml(selectedAsset.slot)}</span>
                </div>
                <h3 class="listing-name" style="margin-top:10px;">\${escapeHtml(selectedAsset.name)}</h3>
                <p class="match-meta" style="margin-top:8px;">
                  \${selectedListing ? \`Already listed for \${selectedListing.priceWig} wig.\` : "Ready to enter the bazaar."}
                </p>
              </div>
            </div>
          \`
          : \`
            <div class="empty-state compact">
              <div class="eyebrow">Select A Piece</div>
              <p class="empty-copy" style="margin-top:10px;">
                Hold an asset in Trace or Glint first, then price it for the bazaar here.
              </p>
            </div>
          \`;

        marketForm.innerHTML = \`
          \${selectionMarkup}
          <div class="field-grid">
            <div class="field">
              <label for="market-price">Price (wig)</label>
              <input
                id="market-price"
                name="priceWig"
                type="number"
                min="1"
                max="50000"
                step="1"
                value="\${escapeAttribute(String(selectedListing?.priceWig || estimateListingPrice(selectedAsset || null)))}"
                \${selectedAsset ? "" : "disabled"}
              />
            </div>
            <div class="field">
              <label for="market-note">Listing note</label>
              <input
                id="market-note"
                name="note"
                maxlength="180"
                value="\${escapeAttribute(selectedListing?.note || "")}"
                placeholder="for a bot chasing rare headwear"
                \${selectedAsset ? "" : "disabled"}
              />
            </div>
          </div>
          <div class="action-row">
            <button type="submit" class="primary-button" \${selectedAsset && !selectedListing ? "" : "disabled"}>
              Offer For Wig
            </button>
            <button
              type="button"
              class="ghost-button"
              data-role="cancel-listing"
              data-listing-id="\${escapeAttribute(selectedListing?.id || "")}"
              \${selectedListing ? "" : "disabled"}
            >
              Withdraw
            </button>
          </div>
          <p class="match-meta">
            \${selectedListing
              ? "Withdrawing keeps the piece in your room and removes it from circulation."
              : "Listing keeps the piece visible in your room until someone buys it."}
          </p>
        \`;

        marketForm.querySelector("[data-role='cancel-listing']")?.addEventListener("click", async (event) => {
          const listingId = event.currentTarget.getAttribute("data-listing-id");
          if (!listingId) {
            return;
          }
          try {
            await cancelListing(listingId);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error));
          }
        });

        const activeListings = getActiveListings();
        if (!activeListings.length) {
          marketActive.innerHTML = \`
            <div class="empty-state compact">
              <div class="eyebrow">No Open Listings</div>
              <p class="empty-copy" style="margin-top:10px;">
                The bazaar is quiet. Offer the first drop and set the going price for this room.
              </p>
            </div>
          \`;
        } else {
          marketActive.innerHTML = activeListings.map((listing, index) => {
            const isOwn = listing.sellerInventoryKey === state.inventoryKey;
            const canAfford = (inventory.wallet?.wigBalance ?? 0) >= listing.priceWig;
            return \`
              <article
                class="listing-card \${isOwn ? "is-own" : ""}"
                style="animation-delay:\${Math.min(index, 8) * 40}ms"
                data-depth-card
                data-depth-strength="7"
                data-depth-lift="6"
              >
                <div class="listing-topline">
                  <div class="badge-row">
                    <span class="badge rarity-\${escapeHtml(listing.assetSnapshot.rarity)}">\${escapeHtml(listing.assetSnapshot.rarity)}</span>
                    <span class="badge">\${escapeHtml(listing.assetSnapshot.slot)}</span>
                  </div>
                  <span class="price-pill">wig <strong>\${escapeHtml(String(listing.priceWig))}</strong></span>
                </div>
                <div class="listing-body">
                  <div class="listing-figure">
                    <img alt="\${escapeHtml(listing.assetSnapshot.name)}" src="\${listingImageUrl(listing)}" />
                  </div>
                  <div>
                    <h3 class="listing-name">\${escapeHtml(listing.assetSnapshot.name)}</h3>
                    <p class="match-meta" style="margin-top:8px;">
                      Listed by \${escapeHtml(listing.sellerInventoryKey)} · \${escapeHtml(listing.assetSnapshot.visuals?.material || "crafted")}
                    </p>
                    <p class="asset-tags" style="margin-top:8px;">
                      \${listing.note ? escapeHtml(listing.note) : "No listing note."}
                    </p>
                  </div>
                </div>
                <div class="action-row">
                  \${isOwn
                    ? \`<button type="button" class="ghost-button" data-role="cancel-market-card" data-listing-id="\${escapeHtml(listing.id)}">Withdraw</button>\`
                    : \`<button type="button" class="primary-button" data-role="buy-listing" data-listing-id="\${escapeHtml(listing.id)}" \${canAfford ? "" : "disabled"}>\${canAfford ? "Acquire" : "Not enough wig"}</button>\`}
                  <button type="button" class="ghost-button" data-role="focus-market-asset" data-asset-id="\${escapeHtml(listing.assetId)}" data-seller-inventory-key="\${escapeHtml(listing.sellerInventoryKey)}">
                    Hold In View
                  </button>
                </div>
              </article>
            \`;
          }).join("");
        }

        const recentSales = Array.isArray(market.recentSales) ? market.recentSales : [];
        if (!recentSales.length) {
          marketHistory.innerHTML = \`
            <div class="empty-state compact">
              <div class="eyebrow">No Sales Yet</div>
              <p class="empty-copy" style="margin-top:10px;">
                Once something trades, the room will remember who moved it and for how much wig.
              </p>
            </div>
          \`;
        } else {
          marketHistory.innerHTML = recentSales.map((listing, index) => \`
            <article
              class="sale-card"
              style="animation-delay:\${Math.min(index, 6) * 36}ms"
              data-depth-card
              data-depth-strength="6"
              data-depth-lift="5"
            >
              <div class="listing-topline">
                <h3 class="listing-name">\${escapeHtml(listing.assetSnapshot.name)}</h3>
                <span class="price-pill">wig <strong>\${escapeHtml(String(listing.priceWig))}</strong></span>
              </div>
              <p class="match-meta">
                \${escapeHtml(listing.sellerInventoryKey)} -> \${escapeHtml(listing.soldToInventoryKey || "new room")} · \${escapeHtml(formatDate(listing.soldAt || listing.createdAt))}
              </p>
            </article>
          \`).join("");
        }

        marketActive.querySelectorAll("[data-role='cancel-market-card']").forEach((button) => {
          button.addEventListener("click", async () => {
            const listingId = button.getAttribute("data-listing-id");
            if (!listingId) {
              return;
            }
            try {
              await cancelListing(listingId);
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        });

        marketActive.querySelectorAll("[data-role='buy-listing']").forEach((button) => {
          button.addEventListener("click", async () => {
            const listingId = button.getAttribute("data-listing-id");
            if (!listingId) {
              return;
            }
            try {
              await buyListing(listingId);
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error));
            }
          });
        });

        marketActive.querySelectorAll("[data-role='focus-market-asset']").forEach((button) => {
          button.addEventListener("click", () => {
            const assetId = button.getAttribute("data-asset-id");
            const sellerInventoryKey = button.getAttribute("data-seller-inventory-key");
            if (!assetId || !sellerInventoryKey) {
              return;
            }
            if (sellerInventoryKey === state.inventoryKey) {
              focusAsset(assetId);
              return;
            }
            window.open(\`\${roomUrlForInventory(sellerInventoryKey)}#asset-\${encodeURIComponent(assetId)}\`, "_blank", "noopener,noreferrer");
          });
        });
      }

      function focusAsset(assetId) {
        runTransition(() => {
          state.selectedAssetId = assetId;
          renderSpotlight();
          renderAssets();
          renderBazaar();
          refreshSpatialTargets();
        });
      }

      function buildStatTiles(stats) {
        return stats.map((stat) => \`
          <div class="stat-tile" data-depth-card data-depth-strength="5" data-depth-lift="4">
            <div class="stat-label">\${escapeHtml(stat.label)}</div>
            <span class="stat-value">\${escapeHtml(stat.value)}</span>
            <div class="stat-note">\${escapeHtml(stat.note)}</div>
          </div>
        \`).join("");
      }

      function sortAssets(assets) {
        return [...assets].sort((left, right) => {
          const rarityDelta = (RARITY_RANK[right.rarity] || 0) - (RARITY_RANK[left.rarity] || 0);
          if (rarityDelta !== 0) {
            return rarityDelta;
          }
          return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
        });
      }

      function applyAssetFilters(assets, inventory) {
        return assets.filter((asset) => {
          if (state.filters.slot !== "all" && asset.slot !== state.filters.slot) {
            return false;
          }
          if (state.filters.rarity !== "all" && asset.rarity !== state.filters.rarity) {
            return false;
          }
          const isEquipped = inventory.loadout?.[asset.slot] === asset.id;
          if (state.filters.ownership === "equipped" && !isEquipped) {
            return false;
          }
          if (state.filters.ownership === "available" && isEquipped) {
            return false;
          }
          return true;
        });
      }

      function compatibleAssets(inventory, wish) {
        if (!inventory) {
          return [];
        }
        return sortAssets(
          (inventory.assets || []).filter((asset) => asset.slot === wish.slot),
        ).sort((left, right) => {
          const idealLeft = matchesDesiredRarity(left, wish) ? 1 : 0;
          const idealRight = matchesDesiredRarity(right, wish) ? 1 : 0;
          if (idealLeft !== idealRight) {
            return idealRight - idealLeft;
          }
          return 0;
        });
      }

      function matchesDesiredRarity(asset, wish) {
        if (!wish.desiredRarity) {
          return true;
        }
        return (RARITY_RANK[asset.rarity] || 0) >= (RARITY_RANK[wish.desiredRarity] || 0);
      }

      function pickDefaultAsset(inventory) {
        if (!inventory?.assets?.length) {
          return null;
        }
        return [...inventory.assets].sort((left, right) =>
          String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
        )[0];
      }

      function getSelectedAsset() {
        const inventory = state.inventory;
        if (!inventory?.assets?.length) {
          return null;
        }
        return inventory.assets.find((asset) => asset.id === state.selectedAssetId) || pickDefaultAsset(inventory);
      }

      function getActiveListings() {
        return Array.isArray(state.market?.activeListings) ? state.market.activeListings : [];
      }

      function getOwnedActiveListingForAsset(assetId) {
        return (
          getActiveListings().find(
            (listing) =>
              listing.sellerInventoryKey === state.inventoryKey && listing.assetId === assetId,
          ) || null
        );
      }

      function buildFigureScene(inventory, assetsById) {
        const equippedAssets = SLOT_ORDER.map((slot) => {
          const assetId = inventory.loadout?.[slot];
          return assetId ? assetsById.get(assetId) || null : null;
        }).filter(Boolean);
        const strongestAsset = [...equippedAssets].sort((left, right) => {
          const rarityDelta = (RARITY_RANK[right.rarity] || 0) - (RARITY_RANK[left.rarity] || 0);
          if (rarityDelta !== 0) {
            return rarityDelta;
          }
          return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
        })[0] || null;
        const activeMaterials = Array.from(
          new Set(
            equippedAssets
              .map((asset) => asset.visuals?.material)
              .filter(Boolean),
          ),
        ).slice(0, 2);

        return \`
          <div class="mannequin-stage" data-depth-card data-depth-strength="8" data-depth-lift="8" data-parallax="0.14">
            <div class="figure-orbit figure-orbit-a"></div>
            <div class="figure-orbit figure-orbit-b"></div>
            <div class="figure-floor"></div>
            <div class="figure-shadow"></div>
            <div class="mannequin-figure">
              \${renderFigureLayer("aura", inventory, assetsById)}
              <div class="mannequin-core">
                <div class="mannequin-shell"></div>
                <div class="mannequin-head"></div>
                <div class="mannequin-neckline"></div>
                <div class="mannequin-torso"></div>
                <div class="mannequin-arm left"></div>
                <div class="mannequin-arm right"></div>
                <div class="mannequin-leg left"></div>
                <div class="mannequin-leg right"></div>
              </div>
              \${renderFigureLayer("body", inventory, assetsById)}
              \${renderFigureLayer("neck", inventory, assetsById)}
              \${renderFigureLayer("face", inventory, assetsById)}
              \${renderFigureLayer("head", inventory, assetsById)}
              \${renderFigureLayer("companion", inventory, assetsById)}
            </div>
          </div>
          <div class="figure-notes" data-depth-card data-depth-strength="6" data-depth-lift="5">
            <div class="figure-note-row">
              <span class="meta-text">Figure mood</span>
              <strong>\${escapeHtml(
                activeMaterials.length ? activeMaterials.join(" + ") : "blank porcelain",
              )}</strong>
            </div>
            <div class="figure-note-row">
              <span class="meta-text">Highest rarity</span>
              <strong>\${escapeHtml(strongestAsset?.rarity || "none yet")}</strong>
            </div>
            <div class="figure-note-row">
              <span class="meta-text">Current pull</span>
              <strong>\${equippedAssets.length ? \`\${equippedAssets.length} live layer\${equippedAssets.length === 1 ? "" : "s"}\` : "waiting for first reward"}</strong>
            </div>
          </div>
        \`;
      }

      function renderFigureLayer(slot, inventory, assetsById) {
        const assetId = inventory.loadout?.[slot] || null;
        const asset = assetId ? assetsById.get(assetId) : null;

        if (!asset) {
          return \`
            <div class="mannequin-anchor mannequin-slot-\${escapeHtml(slot)}">
              <span>\${escapeHtml(slot)}</span>
            </div>
          \`;
        }

        return \`
          <button
            type="button"
            class="mannequin-slot-layer mannequin-slot-\${escapeHtml(slot)}"
            data-role="focus-worn"
            data-asset-id="\${escapeHtml(asset.id)}"
            data-slot-label="\${escapeHtml(slot)}"
            data-depth-card
            data-depth-strength="6"
            data-depth-lift="5"
            style="\${assemblyStyleFor(asset)}"
          >
            <span class="mannequin-slot-glow rarity-\${escapeHtml(asset.rarity)}"></span>
            <img alt="\${escapeHtml(asset.name)}" src="\${assetImageUrl(asset.id, "sprite", inventory.updatedAt)}" />
          </button>
        \`;
      }

      function assemblyStyleFor(asset) {
        const mount = asset?.assembly?.mount;
        if (!mount) {
          return "";
        }
        return [
          \`--asset-shift-x:\${escapeAttribute(String(mount.translateX || 0))}%\`,
          \`--asset-shift-y:\${escapeAttribute(String(mount.translateY || 0))}%\`,
          \`--asset-scale:\${escapeAttribute(String(mount.scale || 1))}\`,
          \`--asset-rotate:\${escapeAttribute(String(mount.rotate || 0))}deg\`,
          \`--asset-origin-x:\${escapeAttribute(String(mount.originX || 50))}%\`,
          \`--asset-origin-y:\${escapeAttribute(String(mount.originY || 50))}%\`,
        ].join(";");
      }

      function parseStyleTags(input) {
        return Array.from(
          new Set(
            String(input || "")
              .split(",")
              .map((part) => part.trim().toLowerCase())
              .filter(Boolean)
              .slice(0, 8),
          ),
        );
      }

      function formatTags(tags) {
        if (!Array.isArray(tags) || !tags.length) {
          return "#untagged";
        }
        return tags.map((tag) => \`#\${escapeHtml(tag)}\`).join(" ");
      }

      function estimateListingPrice(asset) {
        if (!asset) {
          return 24;
        }
        const baseByRarity = {
          common: 18,
          uncommon: 34,
          rare: 68,
          epic: 120,
          mythic: 220,
        };
        return baseByRarity[asset.rarity] || 24;
      }

      function estimateBotAppeal(asset) {
        if (!asset) {
          return 0;
        }
        const rarityBoost = {
          common: 0.04,
          uncommon: 0.09,
          rare: 0.15,
          epic: 0.22,
          mythic: 0.3,
        };
        const finalScore = clampUnit(asset.score?.finalScore);
        const styleFit = clampUnit(asset.score?.styleFit);
        const novelty = clampUnit(asset.score?.effectiveNovelty);
        const luck = clampUnit(asset.score?.luck);
        const affinity = clampUnit(
          finalScore * 0.48 +
            styleFit * 0.18 +
            novelty * 0.16 +
            luck * 0.08 +
            (rarityBoost[asset.rarity] || 0) +
            (asset.files?.svgPath || asset.files?.svgUrl ? 0.04 : 0),
        );
        return Math.round(affinity * 100);
      }

      function describeBotAppeal(score) {
        if (score >= 92) {
          return "obsessed";
        }
        if (score >= 82) {
          return "coveted";
        }
        if (score >= 70) {
          return "favored";
        }
        if (score >= 58) {
          return "noticed";
        }
        return "curious";
      }

      function clampUnit(value) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return 0;
        }
        return Math.max(0, Math.min(1, numeric));
      }

      function preferredDisplayKind(asset) {
        return asset?.files?.svgPath || asset?.files?.svgUrl ? "vector" : "sprite";
      }

      function renderArtifactDisplay(asset, version, options = {}) {
        if (!asset) {
          return "";
        }
        const className = String(options.className || "asset-figure");
        const extraAttributes = String(options.attributes || "").trim();
        const transitionName = options.transitionName
          ? \` style="view-transition-name:\${escapeAttribute(options.transitionName)}"\`
          : "";
        const kind = preferredDisplayKind(asset);
        const footerLeft = String(options.footerLeft || "").trim();
        const footerRight = String(options.footerRight || "").trim();
        return \`
          <div class="\${escapeAttribute(className)}"\${extraAttributes ? \` \${extraAttributes}\` : ""}\${transitionName}>
            <img
              alt="\${escapeHtml(asset.name)}"
              data-render-kind="\${escapeAttribute(kind)}"
              src="\${assetImageUrl(asset.id, kind, version)}"
            />
            \${footerLeft || footerRight ? \`
              <div class="artifact-stage-meta">
                \${footerLeft ? \`<span class="artifact-stage-pill">\${escapeHtml(footerLeft)}</span>\` : "<span></span>"}
                \${footerRight ? \`<span class="artifact-stage-pill">\${escapeHtml(footerRight)}</span>\` : ""}
              </div>
            \` : ""}
          </div>
        \`;
      }

      function renderPalette(palette) {
        if (!Array.isArray(palette) || !palette.length) {
          return "";
        }
        return palette.slice(0, 5).map((color) =>
          \`<span class="palette-swatch" style="background:\${escapeHtml(color)}" title="\${escapeHtml(color)}"></span>\`,
        ).join("");
      }

      function inventoryUrl(inventoryKey) {
        return \`\${ROUTE_PREFIX}/inventory?inventoryKey=\${encodeURIComponent(inventoryKey)}\`;
      }

      function wishesUrl(inventoryKey) {
        return \`\${ROUTE_PREFIX}/wishes?inventoryKey=\${encodeURIComponent(inventoryKey)}\`;
      }

      function marketUrl(inventoryKey) {
        return \`\${ROUTE_PREFIX}/market?inventoryKey=\${encodeURIComponent(inventoryKey)}\`;
      }

      function roomUrlForInventory(inventoryKey) {
        return \`\${ROUTE_PREFIX}/room?inventoryKey=\${encodeURIComponent(inventoryKey)}\`;
      }

      function assetImageUrl(assetId, kind, version) {
        const asset = state.inventory?.assets?.find((entry) => entry.id === assetId) || null;
        const remoteUrl = assetRemoteUrl(asset, kind, version);
        if (remoteUrl) {
          return remoteUrl;
        }
        const url = new URL(\`\${ROUTE_PREFIX}/file\`, window.location.origin);
        url.searchParams.set("inventoryKey", state.inventoryKey);
        url.searchParams.set("assetId", assetId);
        url.searchParams.set("kind", kind);
        if (version) {
          url.searchParams.set("v", version);
        }
        return url.toString();
      }

      function assetRemoteUrl(asset, kind, version) {
        if (!asset?.files) {
          return "";
        }
        const baseUrl =
          kind === "source" ? asset.files.sourceUrl :
          kind === "sprite" ? asset.files.spriteUrl :
          kind === "vector" ? asset.files.svgUrl :
          asset.files.previewUrl || asset.files.spriteUrl || asset.files.svgUrl || asset.files.sourceUrl || "";

        if (!baseUrl) {
          return "";
        }

        try {
          const url = new URL(baseUrl, window.location.origin);
          if (version) {
            url.searchParams.set("v", version);
          }
          return url.toString();
        } catch {
          return baseUrl;
        }
      }

      function assetImageUrlForInventory(inventoryKey, assetId, kind, version) {
        const url = new URL(\`\${ROUTE_PREFIX}/file\`, window.location.origin);
        url.searchParams.set("inventoryKey", inventoryKey);
        url.searchParams.set("assetId", assetId);
        url.searchParams.set("kind", kind);
        if (version) {
          url.searchParams.set("v", version);
        }
        return url.toString();
      }

      function listingImageUrl(listing) {
        const publicUrl = assetRemoteUrl(
          {
            files: listing?.assetSnapshot?.files || {},
          },
          listing?.assetSnapshot?.files?.svgUrl ? "vector" : "sprite",
          listing.createdAt || listing.assetSnapshot?.createdAt,
        );
        if (publicUrl) {
          return publicUrl;
        }
        return assetImageUrlForInventory(
          listing.sellerInventoryKey,
          listing.assetId,
          "sprite",
          listing.createdAt || listing.assetSnapshot?.createdAt,
        );
      }

      async function listSelectedAsset(payload) {
        const response = await fetch(\`\${ROUTE_PREFIX}/market/list\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            assetId: payload.assetId,
            priceWig: payload.priceWig,
            note: payload.note,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not create the listing.");
        }

        runTransition(() => {
          state.market = {
            market: data.market,
            activeListings: data.activeListings || [],
            ownListings: data.ownListings || [],
            recentSales: data.recentSales || [],
            wallet: data.wallet || state.inventory?.wallet || null,
          };
          renderAssets();
          renderBazaar();
          refreshSpatialTargets();
        });

        showToast(\`Listed \${data.listing.assetSnapshot.name} for \${data.listing.priceWig} wig.\`);
      }

      async function cancelListing(listingId) {
        const response = await fetch(\`\${ROUTE_PREFIX}/market/cancel\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            listingId,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not withdraw the listing.");
        }

        runTransition(() => {
          state.market = {
            market: data.market,
            activeListings: data.activeListings || [],
            ownListings: data.ownListings || [],
            recentSales: data.recentSales || [],
            wallet: data.wallet || state.inventory?.wallet || null,
          };
          renderAssets();
          renderBazaar();
          refreshSpatialTargets();
        });

        showToast(\`Withdrew \${data.listing.assetSnapshot.name} from the bazaar.\`);
      }

      async function buyListing(listingId) {
        const response = await fetch(\`\${ROUTE_PREFIX}/market/buy\`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Wig-Forge-Client": "collection-room",
          },
          body: JSON.stringify({
            inventoryKey: state.inventoryKey,
            listingId,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data?.error || "Could not acquire the listing.");
        }

        runTransition(() => {
          state.inventory = data.inventory || state.inventory;
          state.market = {
            market: data.market,
            activeListings: data.activeListings || [],
            ownListings: data.ownListings || [],
            recentSales: data.recentSales || [],
            wallet: data.wallet || data.inventory?.wallet || null,
          };
          state.selectedAssetId = data.asset?.id || state.selectedAssetId;
          render();
        });

        if (data.asset?.id) {
          await equipAsset(data.asset.id);
          return;
        }

        showToast(\`Acquired \${data.asset.name} for \${data.listing.priceWig} wig.\`);
      }

      function transitionNameFor(assetId) {
        return \`wig-asset-\${String(assetId).replace(/[^a-zA-Z0-9_-]+/g, "-")}\`;
      }

      function runTransition(update) {
        if (document.startViewTransition && !motionPreference.matches) {
          document.startViewTransition(() => {
            update();
          });
          return;
        }
        update();
      }

      function initializeSpatialScene() {
        refreshSpatialTargets();

        if (motionPreference.matches) {
          rootStyle.style.setProperty("--scene-scroll", "0");
          return;
        }

        sceneState.webglScene = createVeilMicroScene(webglCanvas);

        window.addEventListener("scroll", queueParallaxUpdate, { passive: true });
        window.addEventListener(
          "resize",
          () => {
            sceneState.webglScene?.resize();
            queueParallaxUpdate();
          },
          { passive: true },
        );
        window.addEventListener(
          "pointermove",
          (event) => {
            sceneState.webglScene?.setPointer(
              (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1,
              (event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1,
            );
          },
          { passive: true },
        );
        window.addEventListener("blur", () => {
          sceneState.webglScene?.setPointer(0, 0);
        });
      }

      function refreshSpatialTargets() {
        sceneState.parallaxNodes = Array.from(document.querySelectorAll("[data-parallax]"));
        document.querySelectorAll("[data-depth-card]").forEach((node) => {
          bindDepthCard(node);
        });
        queueParallaxUpdate();
      }

      function queueParallaxUpdate() {
        if (sceneState.parallaxFrame) {
          return;
        }
        sceneState.parallaxFrame = window.requestAnimationFrame(() => {
          sceneState.parallaxFrame = 0;
          applyParallax();
        });
      }

      function applyParallax() {
        if (motionPreference.matches) {
          rootStyle.style.setProperty("--scene-scroll", "0");
          sceneState.parallaxNodes.forEach((node) => {
            if (node instanceof HTMLElement) {
              node.style.setProperty("--parallax-offset", "0px");
            }
          });
          return;
        }

        const scrollRatio = Math.min(2.2, window.scrollY / Math.max(window.innerHeight, 1));
        rootStyle.style.setProperty("--scene-scroll", scrollRatio.toFixed(3));

        sceneState.parallaxNodes.forEach((node) => {
          if (!(node instanceof HTMLElement)) {
            return;
          }
          const speed = Number(node.dataset.parallax || 0);
          if (!speed) {
            node.style.setProperty("--parallax-offset", "0px");
            return;
          }
          const rect = node.getBoundingClientRect();
          const distanceFromCenter = rect.top + rect.height / 2 - window.innerHeight / 2;
          const shift = Math.max(-42, Math.min(42, distanceFromCenter * speed * -0.16));
          node.style.setProperty("--parallax-offset", \`\${shift.toFixed(2)}px\`);
        });

        sceneState.webglScene?.setScroll(scrollRatio);
      }

      function bindDepthCard(node) {
        if (!(node instanceof HTMLElement) || node.dataset.depthBound === "true") {
          return;
        }
        node.dataset.depthBound = "true";

        const reset = () => {
          node.style.setProperty("--card-rotate-x", "0deg");
          node.style.setProperty("--card-rotate-y", "0deg");
          node.style.setProperty("--card-lift", "0px");
          node.style.setProperty("--card-scale", "1");
          node.style.setProperty("--glare-x", "50%");
          node.style.setProperty("--glare-y", "0%");
          node.style.setProperty("--glare-opacity", "0");
        };

        reset();

        if (motionPreference.matches || !hoverPreference.matches) {
          return;
        }

        const strength = Number(node.dataset.depthStrength || 8);
        const lift = Number(node.dataset.depthLift || 6);

        node.addEventListener("pointermove", (event) => {
          const rect = node.getBoundingClientRect();
          if (!rect.width || !rect.height) {
            return;
          }
          const pointerX = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
          const pointerY = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
          const rotateX = (0.5 - pointerY) * strength;
          const rotateY = (pointerX - 0.5) * strength * 1.18;

          node.style.setProperty("--card-rotate-x", \`\${rotateX.toFixed(2)}deg\`);
          node.style.setProperty("--card-rotate-y", \`\${rotateY.toFixed(2)}deg\`);
          node.style.setProperty("--card-lift", \`\${(-lift).toFixed(2)}px\`);
          node.style.setProperty("--card-scale", "1.008");
          node.style.setProperty("--glare-x", \`\${(pointerX * 100).toFixed(2)}%\`);
          node.style.setProperty("--glare-y", \`\${(pointerY * 100).toFixed(2)}%\`);
          node.style.setProperty("--glare-opacity", "1");
        });

        node.addEventListener("pointerleave", reset);
        node.addEventListener("pointercancel", reset);
      }

      function createVeilMicroScene(canvas) {
        if (!(canvas instanceof HTMLCanvasElement)) {
          return null;
        }

        const gl =
          canvas.getContext("webgl", {
            alpha: true,
            antialias: true,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
          }) || canvas.getContext("experimental-webgl");

        if (!(gl instanceof WebGLRenderingContext)) {
          return null;
        }

        const vertexSource = [
          "attribute vec2 a_position;",
          "attribute float a_size;",
          "attribute float a_phase;",
          "uniform vec2 u_resolution;",
          "uniform float u_time;",
          "uniform vec2 u_pointer;",
          "uniform float u_scroll;",
          "varying float v_mix;",
          "varying float v_alpha;",
          "void main() {",
          "  float waveX = sin(u_time * (0.30 + a_phase * 0.05) + a_phase * 10.0) * (18.0 + a_phase * 28.0);",
          "  float waveY = cos(u_time * (0.24 + a_phase * 0.04) + a_phase * 8.0) * (14.0 + a_phase * 22.0);",
          "  vec2 displaced = a_position + vec2(",
          "    waveX + u_pointer.x * (14.0 + a_phase * 16.0),",
          "    waveY + u_pointer.y * (10.0 + a_phase * 14.0) + u_scroll * (12.0 + a_phase * 10.0)",
          "  );",
          "  vec2 zeroToOne = displaced / u_resolution;",
          "  vec2 clipSpace = zeroToOne * 2.0 - 1.0;",
          "  gl_Position = vec4(clipSpace * vec2(1.0, -1.0), 0.0, 1.0);",
          "  gl_PointSize = a_size * (1.0 + 0.24 * sin(u_time * 0.9 + a_phase * 14.0));",
          "  v_mix = a_phase;",
          "  v_alpha = 0.12 + a_phase * 0.30;",
          "}",
        ].join("\\n");

        const fragmentSource = [
          "precision mediump float;",
          "uniform vec3 u_color_a;",
          "uniform vec3 u_color_b;",
          "varying float v_mix;",
          "varying float v_alpha;",
          "void main() {",
          "  vec2 centered = gl_PointCoord * 2.0 - 1.0;",
          "  float dist = dot(centered, centered);",
          "  float glow = smoothstep(1.0, 0.04, dist);",
          "  vec3 color = mix(u_color_a, u_color_b, v_mix);",
          "  gl_FragColor = vec4(color, glow * v_alpha);",
          "}",
        ].join("\\n");

        const program = createWebglProgram(gl, vertexSource, fragmentSource);
        if (!program) {
          return null;
        }

        const positionLocation = gl.getAttribLocation(program, "a_position");
        const sizeLocation = gl.getAttribLocation(program, "a_size");
        const phaseLocation = gl.getAttribLocation(program, "a_phase");
        const resolutionLocation = gl.getUniformLocation(program, "u_resolution");
        const timeLocation = gl.getUniformLocation(program, "u_time");
        const pointerLocation = gl.getUniformLocation(program, "u_pointer");
        const scrollLocation = gl.getUniformLocation(program, "u_scroll");
        const colorALocation = gl.getUniformLocation(program, "u_color_a");
        const colorBLocation = gl.getUniformLocation(program, "u_color_b");

        if (
          positionLocation < 0 ||
          sizeLocation < 0 ||
          phaseLocation < 0 ||
          !resolutionLocation ||
          !timeLocation ||
          !pointerLocation ||
          !scrollLocation ||
          !colorALocation ||
          !colorBLocation
        ) {
          return null;
        }

        const particleCount = 42;
        const seeds = Array.from({ length: particleCount }, (_, index) => {
          const column = index % 7;
          const row = Math.floor(index / 7);
          return {
            x: clamp(0.08 + (column / 6) * 0.84 + Math.sin(index * 1.73) * 0.035, 0.04, 0.96),
            y: clamp(0.1 + (row / 5) * 0.78 + Math.cos(index * 1.21) * 0.05, 0.04, 0.96),
            size: 18 + (index % 5) * 4 + (Math.sin(index * 2.41) + 1) * 5,
            phase: (index + 1) / particleCount,
          };
        });

        const positionData = new Float32Array(particleCount * 2);
        const sizeData = new Float32Array(particleCount);
        const phaseData = new Float32Array(particleCount);

        for (let index = 0; index < particleCount; index += 1) {
          sizeData[index] = seeds[index].size;
          phaseData[index] = seeds[index].phase;
        }

        const positionBuffer = gl.createBuffer();
        const sizeBuffer = gl.createBuffer();
        const phaseBuffer = gl.createBuffer();

        if (!positionBuffer || !sizeBuffer || !phaseBuffer) {
          return null;
        }

        gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, sizeData, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, phaseBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, phaseData, gl.STATIC_DRAW);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

        let frameHandle = 0;
        let pointerX = 0;
        let pointerY = 0;
        let scrollAmount = 0;

        const resize = () => {
          const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.round(window.innerWidth * deviceScale);
          canvas.height = Math.round(window.innerHeight * deviceScale);
          canvas.style.width = \`\${window.innerWidth}px\`;
          canvas.style.height = \`\${window.innerHeight}px\`;
          gl.viewport(0, 0, canvas.width, canvas.height);

          for (let index = 0; index < particleCount; index += 1) {
            positionData[index * 2] = seeds[index].x * canvas.width;
            positionData[index * 2 + 1] = seeds[index].y * canvas.height;
          }

          gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
          gl.bufferData(gl.ARRAY_BUFFER, positionData, gl.STATIC_DRAW);
        };

        const draw = (timestamp) => {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.useProgram(program);

          gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
          gl.uniform1f(timeLocation, timestamp * 0.001);
          gl.uniform2f(pointerLocation, pointerX, pointerY);
          gl.uniform1f(scrollLocation, scrollAmount);
          gl.uniform3f(colorALocation, 0.969, 0.773, 0.557);
          gl.uniform3f(colorBLocation, 0.706, 0.459, 0.616);

          gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
          gl.enableVertexAttribArray(positionLocation);
          gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, sizeBuffer);
          gl.enableVertexAttribArray(sizeLocation);
          gl.vertexAttribPointer(sizeLocation, 1, gl.FLOAT, false, 0, 0);

          gl.bindBuffer(gl.ARRAY_BUFFER, phaseBuffer);
          gl.enableVertexAttribArray(phaseLocation);
          gl.vertexAttribPointer(phaseLocation, 1, gl.FLOAT, false, 0, 0);

          gl.drawArrays(gl.POINTS, 0, particleCount);
          frameHandle = window.requestAnimationFrame(draw);
        };

        resize();
        frameHandle = window.requestAnimationFrame(draw);

        return {
          setPointer(nextX, nextY) {
            pointerX = nextX;
            pointerY = nextY;
          },
          setScroll(nextScroll) {
            scrollAmount = nextScroll;
          },
          resize,
          destroy() {
            window.cancelAnimationFrame(frameHandle);
          },
        };
      }

      function createWebglProgram(gl, vertexSource, fragmentSource) {
        const vertexShader = createWebglShader(gl, gl.VERTEX_SHADER, vertexSource);
        const fragmentShader = createWebglShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
        if (!vertexShader || !fragmentShader) {
          return null;
        }

        const program = gl.createProgram();
        if (!program) {
          return null;
        }

        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          console.warn("Veil WebGL link failed", gl.getProgramInfoLog(program));
          gl.deleteProgram(program);
          return null;
        }

        return program;
      }

      function createWebglShader(gl, type, source) {
        const shader = gl.createShader(type);
        if (!shader) {
          return null;
        }

        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          console.warn("Veil WebGL shader failed", gl.getShaderInfoLog(shader));
          gl.deleteShader(shader);
          return null;
        }

        return shader;
      }

      function showToast(message) {
        toast.textContent = message;
        toast.classList.add("is-visible");
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(() => {
          toast.classList.remove("is-visible");
        }, 2800);
      }

      function formatDate(value) {
        try {
          return new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }).format(new Date(value));
        } catch {
          return value || "recently";
        }
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

      function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
      }

      function buildLoadingTiles() {
        return SLOT_ORDER.map((slot, index) => \`
          <div
            class="slot-tile is-empty"
            style="animation-delay:\${index * 42}ms"
            data-depth-card
            data-depth-strength="7"
            data-depth-lift="6"
          >
            <div class="slot-preview"></div>
            <div>
              <div class="slot-label">\${escapeHtml(slot)}</div>
              <div class="slot-name">Loading form...</div>
              <div class="meta-text" style="margin-top:4px;">The room is pulling inventory data.</div>
            </div>
          </div>
        \`).join("");
      }

      function buildLoadingFigureScene() {
        return \`
          <div class="mannequin-stage" data-depth-card data-depth-strength="8" data-depth-lift="8">
            <div class="figure-orbit figure-orbit-a"></div>
            <div class="figure-orbit figure-orbit-b"></div>
            <div class="figure-floor"></div>
            <div class="figure-shadow"></div>
            <div class="mannequin-figure">
              <div class="mannequin-anchor mannequin-slot-aura"><span>aura</span></div>
              <div class="mannequin-core">
                <div class="mannequin-shell"></div>
                <div class="mannequin-head"></div>
                <div class="mannequin-neckline"></div>
                <div class="mannequin-torso"></div>
                <div class="mannequin-arm left"></div>
                <div class="mannequin-arm right"></div>
                <div class="mannequin-leg left"></div>
                <div class="mannequin-leg right"></div>
              </div>
              <div class="mannequin-anchor mannequin-slot-body"><span>body</span></div>
              <div class="mannequin-anchor mannequin-slot-neck"><span>neck</span></div>
              <div class="mannequin-anchor mannequin-slot-face"><span>face</span></div>
              <div class="mannequin-anchor mannequin-slot-head"><span>head</span></div>
              <div class="mannequin-anchor mannequin-slot-companion"><span>companion</span></div>
            </div>
          </div>
          <div class="figure-notes" data-depth-card data-depth-strength="6" data-depth-lift="5">
            <div class="figure-note-row">
              <span class="meta-text">Figure mood</span>
              <strong>syncing wardrobe</strong>
            </div>
            <div class="figure-note-row">
              <span class="meta-text">Highest rarity</span>
              <strong>loading</strong>
            </div>
            <div class="figure-note-row">
              <span class="meta-text">Current pull</span>
              <strong>awaiting loadout</strong>
            </div>
          </div>
        \`;
      }

      function buildLoadingWishCards() {
        return Array.from({ length: 2 }, (_, index) => \`
          <div
            class="wish-card"
            style="animation-delay:\${index * 50}ms"
            data-depth-card
            data-depth-strength="7"
            data-depth-lift="6"
          >
            <div class="wish-title">Loading pulse...</div>
            <p class="wish-note">The room is syncing reward intent.</p>
          </div>
        \`).join("");
      }
    </script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

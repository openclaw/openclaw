/**
 * LogoOnlyOutro — Full-screen centered "FD Tiles Logo" outro.
 *
 * Progressive tile-by-tile reveal: center-first spiral build,
 * spring overshoot + settle, subtle glow breathe on hold.
 *
 * 7 tiles in 3x3 grid (TL and BR removed).
 * NO text, NO badges, NO UI, NO CTA, NO "powered by".
 *
 * Timing profile (60-frame window):
 *   Build   0–34f  (7 tiles, ~4-6f stagger)
 *   Settle  34–48f (overshoot dampens)
 *   Hold    48–60f (breathe glow)
 *
 * z-index 9999 (rendered by BrandSystemOverlay).
 */
import React from "react";
import type { HeroMarkId } from "../parser/MotionSpecTypes";

// ── Build order: center first, spiral outward ──
const BUILD_ORDER: { r: number; c: number }[] = [
  { r: 1, c: 1 }, // center
  { r: 0, c: 1 }, // top center
  { r: 1, c: 2 }, // middle right
  { r: 2, c: 1 }, // bottom center
  { r: 1, c: 0 }, // middle left
  { r: 0, c: 2 }, // top right
  { r: 2, c: 0 }, // bottom left
];

// ── Timing ──
const STAGGER_FRAMES = 5;  // delay between each tile start
const TILE_BUILD_FRAMES = 12; // each tile's individual build duration
const HOLD_START = 48;

// ── Spring easing with overshoot ──
function springEase(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c4 = (2 * Math.PI) / 3;
  return 1 + Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) * -1;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

// ── Easing helpers ──
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export const LogoOnlyOutro: React.FC<{
  outroFrame: number;   // frames elapsed since outro started
  compScale: number;    // compH / 1920 for responsive scaling
  heroMark?: HeroMarkId;
  logoSize?: number;
}> = ({ outroFrame, compScale, logoSize = 140 }) => {
  const s = compScale;
  const size = Math.round(logoSize * 1.6 * s); // bigger for standalone outro
  const gap = Math.round(6 * s);
  const radius = Math.round(5 * s);

  const gridN = 3;
  const cellSize = (size - gap * (gridN - 1)) / gridN;

  // ── Backing plate ──
  const plateSize = Math.round(size * 1.35);
  const plateRadius = Math.round(28 * s);

  // ── Overall fade in ──
  const fadeInT = clamp01(outroFrame / 8);
  const overallOpacity = easeOutCubic(fadeInT);

  // ── Breathe (after settle) ──
  const breatheFrame = Math.max(0, outroFrame - HOLD_START);
  const breatheScale = 1 + Math.sin(breatheFrame * 0.07) * 0.012;
  const glowIntensity = 0.2 + Math.sin(breatheFrame * 0.05) * 0.1;

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: `translate(-50%, -50%) scale(${breatheScale}) translate3d(0,0,0)`,
        display: "grid",
        placeItems: "center",
        opacity: overallOpacity,
        willChange: "transform, opacity",
        isolation: "isolate" as const,
        mixBlendMode: "normal" as const,
        filter: "none",
        backfaceVisibility: "hidden",
      }}
    >
      {/* Backing plate */}
      <div
        style={{
          position: "absolute",
          width: plateSize,
          height: plateSize,
          borderRadius: plateRadius,
          background: "rgba(0,0,0,0.45)",
          boxShadow: `0 20px 60px rgba(0,0,0,0.55), 0 0 ${Math.round(40 * glowIntensity)}px rgba(148,243,63,${glowIntensity * 0.3})`,
          border: "1px solid rgba(255,255,255,0.05)",
          transform: "translate3d(0,0,0)",
          filter: "none",
          mixBlendMode: "normal" as const,
          backfaceVisibility: "hidden" as const,
        }}
      />
      {/* Tile grid */}
      <div
        style={{
          position: "relative",
          width: size,
          height: size,
          transform: "translate3d(0,0,0)",
        }}
      >
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{
            display: "block",
            shapeRendering: "geometricPrecision",
            overflow: "visible",
          }}
        >
          {BUILD_ORDER.map((pos, idx) => {
            const tileStart = idx * STAGGER_FRAMES;
            const tileAge = outroFrame - tileStart;

            // Scale: 0 → overshoot → 1
            const rawT = clamp01(tileAge / TILE_BUILD_FRAMES);
            const scale = rawT <= 0 ? 0 : springEase(rawT);

            // Opacity: quick fade in per tile
            const opacity = clamp01(tileAge / 5);

            const x = pos.c * (cellSize + gap);
            const y = pos.r * (cellSize + gap);
            const cx = x + cellSize / 2;
            const cy = y + cellSize / 2;

            return (
              <rect
                key={`${pos.r}-${pos.c}`}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx={radius}
                fill="#FFFFFF"
                opacity={opacity}
                transform={`translate(${cx}, ${cy}) scale(${scale}) translate(${-cx}, ${-cy})`}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
};

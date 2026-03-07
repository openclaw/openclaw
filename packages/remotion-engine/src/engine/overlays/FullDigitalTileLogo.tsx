/**
 * FullDigitalTileLogo — Procedural animated "tile build" logo.
 *
 * 7 tiles (3x3 grid minus top-left and bottom-right) animate in:
 *   Phase 1: Assemble (frames 0–20) — tiles pop in with stagger, overshoot, opacity
 *   Phase 2: Settle  (frames 20–30) — tiles lock into final position
 *   Phase 3: Breathe (frame 30+)    — subtle scale pulse + green glow
 *
 * Pure SVG — no image assets. GPU-proof.
 */
import React from "react";
import { useCurrentFrame } from "remotion";

// Build order: center first, spiral outward for premium feel
// 3x3 grid with top-left (0,0) and bottom-right (2,2) removed = 7 tiles
const BUILD_ORDER: { r: number; c: number }[] = [
  { r: 1, c: 1 }, // center
  { r: 0, c: 1 }, // top center
  { r: 1, c: 0 }, // middle left
  { r: 1, c: 2 }, // middle right
  { r: 2, c: 0 }, // bottom left
  { r: 0, c: 2 }, // top right
  { r: 2, c: 1 }, // bottom center
];

// Timing
const ASSEMBLE_FRAMES = 20;
const SETTLE_FRAMES = 10;
const STAGGER_FRAMES = 2.5; // delay between each tile
const TOTAL_BUILD = ASSEMBLE_FRAMES + SETTLE_FRAMES; // 30

// Overshoot easing
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export const FullDigitalTileLogo: React.FC<{
  size?: number;
  gap?: number;
  radius?: number;
  color?: string;
  glowColor?: string;
}> = ({
  size = 120,
  gap = 4,
  radius = 3,
  color = "#FFFFFF",
  glowColor = "#94f33f",
}) => {
  const frame = useCurrentFrame();

  const gridN = 3;
  const cellSize = (size - gap * (gridN - 1)) / gridN;

  // Breathe pulse (starts after build)
  const breatheFrame = Math.max(0, frame - TOTAL_BUILD);
  const breatheScale = 1 + Math.sin(breatheFrame * 0.08) * 0.015;
  const glowOpacity = 0.15 + Math.sin(breatheFrame * 0.06) * 0.08;

  return (
    <div
      style={{
        position: "relative",
        width: size,
        height: size,
        transform: `scale(${breatheScale}) translateZ(0)`,
        transformOrigin: "center center",
        filter: frame > TOTAL_BUILD
          ? `drop-shadow(0 0 ${8 + Math.sin(breatheFrame * 0.06) * 4}px ${glowColor}${Math.round(glowOpacity * 255).toString(16).padStart(2, "0")})`
          : "none",
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
          // Each tile starts at a staggered frame
          const tileStartFrame = idx * STAGGER_FRAMES;
          const tileAge = frame - tileStartFrame;

          // Scale animation: 0 → overshoot → 1
          const scaleT = clamp01(tileAge / (ASSEMBLE_FRAMES - tileStartFrame));
          const scale = scaleT <= 0 ? 0 : easeOutBack(scaleT);

          // Opacity: quick fade in
          const opacity = clamp01(tileAge / 4);

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
              fill={color}
              opacity={opacity}
              transform={`translate(${cx}, ${cy}) scale(${scale}) translate(${-cx}, ${-cy})`}
            />
          );
        })}
      </svg>
    </div>
  );
};

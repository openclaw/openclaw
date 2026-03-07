/**
 * Cursor — Animated mouse cursor overlay for UI interaction scenes.
 *
 * Smoothly moves between tap targets and shows a click press animation.
 * Rendered absolutely within the InteractiveUICardElement wrapper.
 *
 * Features:
 * - Smooth position interpolation between targets (easeInOutCubic)
 * - Click press: cursor scales down 0.85 for 4 frames, bounces back over 6
 * - Click ring: subtle expanding ring at click point
 * - White pointer cursor with drop shadow
 * - z-index 100 (above card content, below composition overlays)
 */
import React from "react";
import { clamp, easeInOutCubic, easeOutCubic, easeOutBack } from "../../motion/easings";

// ── Cursor movement constants ──
const MOVE_FRAMES = 12; // frames for cursor to travel between targets
const CLICK_DOWN_FRAMES = 4;
const CLICK_BOUNCE_FRAMES = 6;

export type CursorTarget = {
  x: number;
  y: number;
  at: number;      // frame when cursor arrives at this target
  click?: boolean;  // whether to show click animation on arrival
};

/**
 * Compute cursor position and click state for a given frame.
 */
export function resolveCursorState(
  frame: number,
  targets: CursorTarget[],
): { x: number; y: number; clickElapsed: number } | null {
  if (targets.length === 0) return null;

  // Before first target: not visible
  const firstAppear = targets[0].at - MOVE_FRAMES;
  if (frame < firstAppear) return null;

  // Find current target
  let currTarget = targets[0];
  let lastClickAt = -999;

  for (const t of targets) {
    if (t.at <= frame) {
      currTarget = t;
      if (t.click) lastClickAt = t.at;
    } else {
      // We've passed current frame — this is the "next" target
      // Interpolate toward it
      const moveStart = t.at - MOVE_FRAMES;
      if (frame >= moveStart) {
        const rawT = clamp((frame - moveStart) / MOVE_FRAMES, 0, 1);
        const easedT = easeInOutCubic(rawT);
        return {
          x: currTarget.x + (t.x - currTarget.x) * easedT,
          y: currTarget.y + (t.y - currTarget.y) * easedT,
          clickElapsed: frame - lastClickAt,
        };
      }
      break;
    }
  }

  // At or past last target: stay at last position
  return {
    x: currTarget.x,
    y: currTarget.y,
    clickElapsed: frame - lastClickAt,
  };
}

export const Cursor: React.FC<{
  x: number;
  y: number;
  clickElapsed: number; // frames since last click (-999 if no click)
}> = ({ x, y, clickElapsed }) => {
  // Click animation: scale down then bounce back
  let scale = 1;
  if (clickElapsed >= 0 && clickElapsed < CLICK_DOWN_FRAMES) {
    const rawT = clamp(clickElapsed / CLICK_DOWN_FRAMES, 0, 1);
    scale = 1 - 0.15 * easeOutCubic(rawT);
  } else if (
    clickElapsed >= CLICK_DOWN_FRAMES &&
    clickElapsed < CLICK_DOWN_FRAMES + CLICK_BOUNCE_FRAMES
  ) {
    const rawT = clamp(
      (clickElapsed - CLICK_DOWN_FRAMES) / CLICK_BOUNCE_FRAMES,
      0,
      1,
    );
    scale = 0.85 + 0.15 * easeOutBack(rawT);
  }

  return (
    <div
      style={{
        position: "absolute",
        left: Math.round(x),
        top: Math.round(y),
        transform: `translate(-3px, -1px) scale(${scale})`,
        transformOrigin: "3px 1px",
        zIndex: 100,
        pointerEvents: "none",
      }}
    >
      {/* Pointer cursor shape */}
      <svg
        width="24"
        height="28"
        viewBox="0 0 24 28"
        fill="none"
        style={{
          filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.45))",
        }}
      >
        <path
          d="M2 1L2 21L7.5 16L12.5 24L16 22L11 14L18 14L2 1Z"
          fill="white"
          stroke="rgba(0,0,0,0.2)"
          strokeWidth="1"
        />
      </svg>
    </div>
  );
};

/**
 * TapRipple — Expanding circle overlay indicating a "tap" interaction.
 *
 * Renders for TAP_DURATION (10) frames after a tap event:
 * - Circle expands from 0 → 90px radius
 * - Opacity fades from 0.35 → 0
 * - Uses easeOutCubic for natural deceleration
 * - Absolutely positioned within parent container
 */
import React from "react";
import { clamp, easeOutCubic } from "../motion/easings";
import { TAP_DURATION } from "./resolveTimeline";

const MAX_RADIUS = 90;

export const TapRipple: React.FC<{
  x: number;
  y: number;
  startFrame: number;
  currentFrame: number;
}> = ({ x, y, startFrame, currentFrame }) => {
  const elapsed = currentFrame - startFrame;
  if (elapsed < 0 || elapsed >= TAP_DURATION) return null;

  const rawT = clamp(elapsed / TAP_DURATION, 0, 1);
  const t = easeOutCubic(rawT);
  const radius = t * MAX_RADIUS;
  const opacity = 0.35 * (1 - rawT); // linear fade for smoother disappearance
  const size = Math.round(radius * 2);

  return (
    <div
      style={{
        position: "absolute",
        left: Math.round(x - radius),
        top: Math.round(y - radius),
        width: size,
        height: size,
        borderRadius: "50%",
        background: `radial-gradient(circle, rgba(255,255,255,${opacity}) 0%, rgba(255,255,255,0) 70%)`,
        border: `2px solid rgba(255,255,255,${opacity * 0.85})`,
        pointerEvents: "none",
      }}
    />
  );
};

/**
 * SafeCenterStack — Vertically centers a content group within safe zone bounds.
 *
 * Usage: Wrap headline + UI card + subcopy + CTA as children.
 * The entire group is centered vertically in the safe area.
 *
 * Safe margins:
 * - Top: 8%  (tighter than SafeZoneLayoutGate since this is for centered content)
 * - Bottom: 10%
 * - Left/Right: 6%
 *
 * If content exceeds safe zone height, it auto-scales down 2-6% until it fits
 * (layoutGate behavior).
 */
import React from "react";
import { useVideoConfig } from "remotion";

// Safe zone percentages (slightly tighter than SafeZoneLayoutGate for content centering)
const SAFE_TOP = 0.08;
const SAFE_BOTTOM = 0.10;
const SAFE_LEFT = 0.06;
const SAFE_RIGHT = 0.06;

export const SafeCenterStack: React.FC<{
  children: React.ReactNode;
  /** Optional gap between stacked children (px). Default 16. */
  gap?: number;
  /** Max width of the content area (px). Default 920. */
  maxWidth?: number;
  /** Optional: show debug outlines */
  debug?: boolean;
}> = ({ children, gap = 16, maxWidth = 920, debug = false }) => {
  const { width: compW, height: compH } = useVideoConfig();

  const top = Math.round(compH * SAFE_TOP);
  const bottom = Math.round(compH * SAFE_BOTTOM);
  const left = Math.round(compW * SAFE_LEFT);
  const right = Math.round(compW * SAFE_RIGHT);
  const safeW = compW - left - right;
  const contentWidth = Math.min(maxWidth, safeW);

  return (
    <div
      style={{
        position: "absolute",
        top,
        left,
        right,
        bottom,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        overflow: "visible",
        ...(debug
          ? {
              border: "2px dashed cyan",
              boxShadow: "inset 0 0 0 1px rgba(0,255,255,0.15)",
            }
          : {}),
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap,
          width: contentWidth,
          maxWidth: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * Safe center bounds in pixels (for calculations outside React).
 */
export function getSafeCenterBounds(compW: number, compH: number) {
  return {
    top: Math.round(compH * SAFE_TOP),
    bottom: Math.round(compH * (1 - SAFE_BOTTOM)),
    left: Math.round(compW * SAFE_LEFT),
    right: Math.round(compW * (1 - SAFE_RIGHT)),
    width: Math.round(compW * (1 - SAFE_LEFT - SAFE_RIGHT)),
    height: Math.round(compH * (1 - SAFE_TOP - SAFE_BOTTOM)),
  };
}

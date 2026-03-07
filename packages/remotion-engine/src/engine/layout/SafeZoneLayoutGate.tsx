/**
 * SafeZoneLayoutGate — Wraps content and ensures it stays within
 * mobile-safe margins. Prevents clipping on phones.
 *
 * Safe margins:
 * - Top: 10% (status bar, notch, dynamic island)
 * - Bottom: 12% (home indicator, nav bar)
 * - Left/Right: 6% (edge rounding)
 *
 * Usage: Wrap scene content in <SafeZoneLayoutGate>
 */
import React from "react";
import { useVideoConfig } from "remotion";

// Safe zone percentages
const SAFE_TOP = 0.10;
const SAFE_BOTTOM = 0.12;
const SAFE_LEFT = 0.06;
const SAFE_RIGHT = 0.06;

export const SafeZoneLayoutGate: React.FC<{
  children: React.ReactNode;
  /** Optional: show debug outlines (magenta border) */
  debug?: boolean;
}> = ({ children, debug = false }) => {
  const { width: compW, height: compH } = useVideoConfig();

  const top = Math.round(compH * SAFE_TOP);
  const bottom = Math.round(compH * SAFE_BOTTOM);
  const left = Math.round(compW * SAFE_LEFT);
  const right = Math.round(compW * SAFE_RIGHT);

  return (
    <div
      style={{
        position: "absolute",
        top,
        left,
        right,
        bottom,
        overflow: "visible", // don't clip, just position
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        ...(debug
          ? {
              border: "2px dashed magenta",
              boxShadow: "inset 0 0 0 1px rgba(255,0,255,0.15)",
            }
          : {}),
      }}
    >
      {children}
    </div>
  );
};

/**
 * Safe zone bounds in pixels (for calculations outside React).
 */
export function getSafeZoneBounds(compW: number, compH: number) {
  return {
    top: Math.round(compH * SAFE_TOP),
    bottom: Math.round(compH * (1 - SAFE_BOTTOM)),
    left: Math.round(compW * SAFE_LEFT),
    right: Math.round(compW * (1 - SAFE_RIGHT)),
    width: Math.round(compW * (1 - SAFE_LEFT - SAFE_RIGHT)),
    height: Math.round(compH * (1 - SAFE_TOP - SAFE_BOTTOM)),
  };
}

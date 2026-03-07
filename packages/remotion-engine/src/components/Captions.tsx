/**
 * Captions.tsx — Remotion-native caption animation system.
 *
 * Renders timed caption segments locked to the 9:16 grid safe zones.
 * Supports three primary styles:
 *   - hormozi_box: bold white text in black rounded box, spring pop-in
 *   - premium_clean: no box, big type, subtle fade_up
 *   - scribble_callout: no box, green underline decoration, snappy entrance
 *
 * Word emphasis highlights in GREEN (#94F33F).
 *
 * Usage:
 *   <Captions
 *     segments={captionSegments}
 *     safe={{ top: 150, bottom: 230, left: 90, right: 90 }}
 *     y={190}
 *   />
 */

import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
} from "remotion";

// ── Types ──
type CaptionStyle = "hormozi_box" | "premium_clean" | "scribble_callout";

interface Segment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  emphasis?: string[];
  style: CaptionStyle;
}

interface SafeMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

// ── Brand constants ──
const GREEN = "#94F33F";

// ── Component ──
export const Captions: React.FC<{
  segments: Segment[];
  safe: SafeMargins;
  y: number;
}> = ({ segments, safe, y }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const seg = segments.find((s) => t >= s.start && t < s.end);
  if (!seg) return null;

  const localFrame = frame - Math.floor(seg.start * fps);

  // ── Spring entrance (shared) ──
  const enter = spring({
    fps,
    frame: localFrame,
    config: { damping: 14, mass: 0.6 },
  });
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const scale = interpolate(enter, [0, 1], [0.98, 1]);

  // ── Exit fade ──
  const segEndFrame = Math.floor(seg.end * fps);
  const exitDuration = 8;
  const exitStart = segEndFrame - exitDuration;
  let exitOpacity = 1;
  if (frame > exitStart) {
    exitOpacity = interpolate(frame, [exitStart, segEndFrame], [1, 0], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  }

  // ── Word emphasis ──
  const words = seg.text.split(" ");
  const emphSet = new Set(
    (seg.emphasis ?? []).map((w) => w.toUpperCase()),
  );

  const isHormozi = seg.style === "hormozi_box";
  const isScribble = seg.style === "scribble_callout";

  // ── Green underline draw for scribble_callout ──
  const underlineWidth = isScribble
    ? interpolate(localFrame, [0, 12], [0, 100], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      })
    : 0;

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: safe.left,
          right: safe.right,
          top: y,
          opacity: opacity * exitOpacity,
          transform: `scale(${scale})`,
          textTransform: "uppercase",
          fontWeight: 900,
          letterSpacing: -0.5,
          lineHeight: 1.05,
          fontSize: isHormozi ? 74 : isScribble ? 72 : 78,
          color: "#fff",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        }}
      >
        <div
          style={{
            display: "inline-block",
            padding: isHormozi ? "18px 22px" : "0px",
            borderRadius: isHormozi ? 18 : 0,
            background: isHormozi ? "rgba(0,0,0,0.78)" : "transparent",
            boxShadow: isHormozi
              ? "0 14px 40px rgba(0,0,0,0.35)"
              : "none",
            position: "relative",
          }}
        >
          {words.map((w, i) => {
            const clean = w.replace(/[^\w]/g, "").toUpperCase();
            const isEmph = emphSet.has(clean);
            return (
              <span key={i} style={{ marginRight: 10 }}>
                <span style={{ color: isEmph ? GREEN : "#fff" }}>
                  {w}
                </span>
              </span>
            );
          })}

          {/* Scribble callout: green underline drawn left→right */}
          {isScribble && (
            <div
              style={{
                position: "absolute",
                bottom: -8,
                left: 0,
                width: `${underlineWidth}%`,
                height: 6,
                background: GREEN,
                borderRadius: 3,
              }}
            />
          )}
        </div>
      </div>
    </AbsoluteFill>
  );
};

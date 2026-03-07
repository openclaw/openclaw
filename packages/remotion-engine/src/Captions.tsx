/**
 * Captions.tsx — First-class caption track for CUTMV MotionSpecs.
 *
 * Renders timed caption segments with style presets:
 *   - hormozi_box: bold white in black box, pop-in
 *   - premium_clean: no box, big type, subtle fade_up
 *   - scribble_callout: black box + scribble underline
 *
 * Usage:
 *   <Captions track={captionTrack} layout={layout} />
 */

import React from "react";
import {
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  spring,
  Easing,
} from "remotion";

// ── Types ──

interface CaptionSegment {
  start: number; // seconds
  end: number; // seconds
  lines: string[];
  emphasis?: string[];
  style_override?: string | null;
}

interface CaptionTrack {
  version: string;
  fps: number;
  style: "hormozi_box" | "premium_clean" | "scribble_callout";
  segments: CaptionSegment[];
}

interface LayoutZone {
  y: number;
  h: number;
}

interface LayoutSafe {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface Layout {
  safe: LayoutSafe;
  zones: {
    hook: LayoutZone;
    demo: LayoutZone;
    cta: LayoutZone;
  };
}

// ── Brand constants ──
const WHITE = "#FFFFFF";
const BLACK = "#000000";
const GREEN = "#94F33F";
const FONT =
  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

// ── Style presets ──
const STYLES = {
  hormozi_box: {
    fontSize: 56,
    fontWeight: 800,
    lineHeight: 1.1,
    bg: BLACK,
    bgOpacity: 0.9,
    padding: { x: 24, y: 16 },
    borderRadius: 12,
    entranceType: "pop" as const,
    entranceDuration: 8,
  },
  premium_clean: {
    fontSize: 64,
    fontWeight: 700,
    lineHeight: 1.15,
    bg: "none",
    bgOpacity: 0,
    padding: { x: 0, y: 0 },
    borderRadius: 0,
    entranceType: "fade_up" as const,
    entranceDuration: 14,
  },
  scribble_callout: {
    fontSize: 48,
    fontWeight: 700,
    lineHeight: 1.15,
    bg: BLACK,
    bgOpacity: 0.75,
    padding: { x: 20, y: 12 },
    borderRadius: 8,
    entranceType: "snap_pop" as const,
    entranceDuration: 6,
  },
};

// ── Emphasis renderer ──
const renderLine = (
  line: string,
  emphasis: string[],
): React.ReactElement[] => {
  if (!emphasis.length) {
    return [<span key="0">{line}</span>];
  }

  const parts: React.ReactElement[] = [];
  let remaining = line;
  let key = 0;

  for (const word of emphasis) {
    const idx = remaining.indexOf(word);
    if (idx === -1) continue;

    if (idx > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, idx)}</span>);
    }
    parts.push(
      <span key={key++} style={{ color: GREEN }}>
        {word}
      </span>,
    );
    remaining = remaining.slice(idx + word.length);
  }

  if (remaining) {
    parts.push(<span key={key++}>{remaining}</span>);
  }

  return parts;
};

// ── Main component ──
export const Captions: React.FC<{
  track: CaptionTrack;
  layout: Layout;
}> = ({ track, layout }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const t = frame / fps;
  const seg = track.segments.find((s) => t >= s.start && t < s.end);
  if (!seg) return null;

  const styleKey = (seg.style_override as keyof typeof STYLES) || track.style;
  const style = STYLES[styleKey] || STYLES.premium_clean;
  const segStartFrame = Math.floor(seg.start * fps);
  const localFrame = frame - segStartFrame;

  // ── Entrance animation ──
  let opacity = 1;
  let scale = 1;
  let translateY = 0;

  if (style.entranceType === "pop") {
    const spr = spring({
      fps,
      frame: localFrame,
      config: { damping: 14, stiffness: 180 },
    });
    opacity = interpolate(spr, [0, 1], [0, 1]);
    scale = interpolate(spr, [0, 1], [0.96, 1]);
  } else if (style.entranceType === "fade_up") {
    opacity = interpolate(
      localFrame,
      [0, style.entranceDuration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    translateY = interpolate(
      localFrame,
      [0, style.entranceDuration],
      [18, 0],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      },
    );
  } else if (style.entranceType === "snap_pop") {
    opacity = interpolate(
      localFrame,
      [0, style.entranceDuration],
      [0, 1],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    scale = interpolate(
      localFrame,
      [0, style.entranceDuration],
      [0.9, 1],
      {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
        easing: Easing.out(Easing.cubic),
      },
    );
  }

  // ── Exit fade ──
  const segEndFrame = Math.floor(seg.end * fps);
  const exitDuration = 8;
  const exitStart = segEndFrame - exitDuration;
  if (frame > exitStart) {
    opacity *= interpolate(
      frame,
      [exitStart, segEndFrame],
      [1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
  }

  const emphasis = seg.emphasis || [];

  return (
    <div
      style={{
        position: "absolute",
        left: layout.safe.left,
        right: layout.safe.right,
        top: layout.zones.hook.y,
        height: layout.zones.hook.h,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity,
        transform: `scale(${scale}) translateY(${translateY}px)`,
        zIndex: 8,
      }}
    >
      <div
        style={{
          ...(style.bg !== "none"
            ? {
                backgroundColor: style.bg,
                opacity: style.bgOpacity,
                padding: `${style.padding.y}px ${style.padding.x}px`,
                borderRadius: style.borderRadius,
              }
            : {}),
          textAlign: "center",
          maxWidth: "82%",
        }}
      >
        {seg.lines.map((line, i) => (
          <div
            key={i}
            style={{
              color: WHITE,
              fontSize: style.fontSize,
              fontWeight: style.fontWeight,
              lineHeight: style.lineHeight,
              fontFamily: FONT,
              textTransform: "uppercase",
              letterSpacing: "0.02em",
            }}
          >
            {renderLine(line, emphasis)}
          </div>
        ))}
      </div>
    </div>
  );
};

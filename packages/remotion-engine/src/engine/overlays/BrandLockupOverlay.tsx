/**
 * BrandLockupOverlay — GPU-proof brand overlay rendered LAST in composition.
 *
 * Layout:
 * - Top: Animated FD tile logo (FullDigitalTileLogo) — 2.2x bigger, positioned
 *   in the top safe zone (~7% from top, well above center content area)
 * - Bottom: "POWERED BY" + FD wordmark SVG
 *
 * Bulletproof rendering:
 * - All positions pixel-snapped (Math.round)
 * - isolation: isolate + mixBlendMode: normal + filter: none on every layer
 * - transform: translateZ(0) for stable GPU compositing
 * - backfaceVisibility: hidden
 * - opacity never below 0.25
 * - z-index 9999
 * - Rendered as LAST child in CutmvAdEngine (after transitions + post FX)
 */
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FullDigitalTileLogo } from "./FullDigitalTileLogo";

const FADE_FRAMES = 12;

/** Real SVG wordmark via staticFile() */
const FD_WORDMARK_SVG = staticFile("cutmv/logo2-wordmark.svg");

/** Pixel-snap helper */
const snap = (n: number) => Math.round(n);

/** GPU-proof style guards */
const SAFE_LAYER: React.CSSProperties = {
  isolation: "isolate" as const,
  mixBlendMode: "normal" as const,
  filter: "none",
  transform: "translateZ(0)",
  backfaceVisibility: "hidden",
  WebkitBackfaceVisibility: "hidden" as const,
  WebkitFontSmoothing: "antialiased" as const,
};

export const BrandLockupOverlay: React.FC<{
  primaryLogo: string;
  durationInFrames: number;
  height?: number;
  maxOpacity?: number;
}> = ({
  durationInFrames,
  maxOpacity = 0.92,
}) => {
  const frame = useCurrentFrame();
  const { height: compH } = useVideoConfig();

  // Fade in / out — never below 0.25
  const fadeIn = Math.min(1, frame / FADE_FRAMES);
  const fadeOut = Math.min(1, (durationInFrames - frame) / FADE_FRAMES);
  const opacity = Math.max(0.25, maxOpacity * Math.min(fadeIn, fadeOut));

  if (frame < 0 || frame >= durationInFrames) return null;

  // Scale proportionally to comp height (base: 1920 = 9:16)
  const s = compH / 1920;

  // ── Top logo: ~2.2x bigger than original, positioned in top safe zone ──
  const logoSize = snap(120 * s);
  const logoGap = snap(4 * s);
  const logoRadius = snap(3 * s);

  // Backing plate: slightly larger than logo
  const plateSize = snap(144 * s);
  const plateRadius = snap(22 * s);

  // Position: ~6.5% from top of comp (safe zone, well above UI content)
  const topY = snap(compH * 0.065);

  // ── Bottom: "POWERED BY" + wordmark ──
  const wordmarkH = snap(16 * s);
  const bottomY = snap(32 * s);

  return (
    <AbsoluteFill
      style={{
        zIndex: 9999,
        pointerEvents: "none",
        ...SAFE_LAYER,
        opacity: 1,
      }}
    >
      {/* ── Top center: Animated tile logo in dark backing plate ── */}
      <div
        style={{
          position: "absolute",
          top: topY,
          left: "50%",
          transform: "translateX(-50%) translateZ(0)",
          display: "grid",
          placeItems: "center",
          ...SAFE_LAYER,
          opacity,
        }}
      >
        {/* Backing plate — prevents blend/filter artifacts */}
        <div
          style={{
            position: "absolute",
            width: plateSize,
            height: plateSize,
            borderRadius: plateRadius,
            background: "rgba(0,0,0,0.40)",
            boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        />
        <div style={{ position: "relative" }}>
          <FullDigitalTileLogo
            size={logoSize}
            gap={logoGap}
            radius={logoRadius}
            color="#FFFFFF"
            glowColor="#94f33f"
          />
        </div>
      </div>

      {/* ── Bottom center: "POWERED BY" + FD wordmark SVG ── */}
      <div
        style={{
          position: "absolute",
          bottom: bottomY,
          left: "50%",
          transform: "translateX(-50%) translateZ(0)",
          textAlign: "center",
          ...SAFE_LAYER,
          opacity: opacity * 0.65,
        }}
      >
        <div
          style={{
            fontSize: snap(11 * s),
            fontWeight: 600,
            letterSpacing: 1.8,
            color: "rgba(255,255,255,0.85)",
            marginBottom: snap(6 * s),
          }}
        >
          POWERED BY
        </div>
        <Img
          src={FD_WORDMARK_SVG}
          style={{
            height: wordmarkH,
            width: "auto",
            display: "block",
            margin: "0 auto",
            ...SAFE_LAYER,
            opacity: 1,
            imageRendering: "auto" as const,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};

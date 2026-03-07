/**
 * BrandSystemOverlay — Simplified 2-layer brand system.
 *
 * Layer 1: Hero Brand Mark (bookend open/close ONLY)
 *   - Dead center (true 50%/50% + translate -50/-50)
 *   - Visible only during OPEN (first openFrames) and CLOSE (last closeFrames)
 *   - Supports interchangeable SVG marks + procedural tile logo
 *   - Optical nudge per asset on logo element (not wrapper)
 *
 * Layer 2: Endcard Lockup
 *   - "POWERED BY" + Full Digital wordmark
 *   - Perfect bottom center, configurable bottomOffset
 *   - Only visible in last showLastFrames (default 60)
 *
 * Brand state gate: endcard wins (hero off when endcard on). Never both.
 * No corner bug. No mid-video logo. No overlaps ever.
 *
 * z-index 9999 (above everything, GPU-proof)
 *
 * EXPORTS:
 *   - BrandSystemOverlay (main component)
 *   - getBrandPhase() (pure function for contextBadge gating)
 */
import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FullDigitalTileLogo } from "./FullDigitalTileLogo";
import { LogoOnlyOutro } from "./LogoOnlyOutro";
import type { MotionSpec, BrandSystemConfig, HeroMarkId } from "../parser/MotionSpecTypes";
import { clamp, easeOutCubic, easeInCubic } from "../motion/easings";

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

// ── Hero mark asset mapping ──
const HERO_MARK_SRC: Record<Exclude<HeroMarkId, "procedural">, string> = {
  fd_logo_2025_white: staticFile("cutmv/fd-logo-2025-white.svg"),
  fd_logo_new: staticFile("cutmv/fd-logo-new.svg"),
};

// ── Optical nudge per asset (applied to logo element, not wrapper) ──
// Corrects SVG viewBox whitespace so visual center == mathematical center
const OPTICAL_NUDGE: Record<HeroMarkId, { x: number; y: number }> = {
  fd_logo_2025_white: { x: -10, y: 0 },
  fd_logo_new: { x: -8, y: 0 },
  procedural: { x: 0, y: 0 },
};

// ── Defaults ──
const DEFAULT_HERO_OPEN_FRAMES = 20;
const DEFAULT_HERO_CLOSE_FRAMES = 26;
const DEFAULT_HERO_SCALE = 1.0;
const DEFAULT_HERO_SIZE = 140;      // bigger for mobile
const DEFAULT_HERO_MARK: HeroMarkId = "fd_logo_new";
const DEFAULT_ENDCARD_SHOW_LAST_FRAMES = 60;
const DEFAULT_ENDCARD_BOTTOM_OFFSET = 72; // px from bottom edge

// ══════════════════════════════════════════════════════════════
// Brand phase detection — exported for contextBadge gating
// ══════════════════════════════════════════════════════════════

export type BrandPhase = "hero_open" | "hero_close" | "endcard" | "none";

/**
 * Pure function: given frame + spec, returns current brand phase.
 * Used by EnvironmentLayer to hide contextBadge during hero/endcard.
 */
export function getBrandPhase(
  frame: number,
  totalFrames: number,
  cfg?: BrandSystemConfig,
): BrandPhase {
  const endcardStyle = cfg?.endcard?.style ?? "lockupA";
  // logoOnly mode: hero is ALWAYS disabled (no logo at start)
  const heroEnabled = endcardStyle === "logoOnly" ? false : (cfg?.hero?.enabled ?? true);
  const endcardEnabled = cfg?.endcard?.enabled ?? true;
  const openFrames = cfg?.hero?.openFrames ?? DEFAULT_HERO_OPEN_FRAMES;
  const closeFrames = cfg?.hero?.closeFrames ?? DEFAULT_HERO_CLOSE_FRAMES;
  const showLastFrames = cfg?.endcard?.showLastFrames ?? DEFAULT_ENDCARD_SHOW_LAST_FRAMES;

  const endcardStart = totalFrames - showLastFrames;
  const closeStart = totalFrames - closeFrames;

  // Priority: endcard wins over hero close (they can overlap in time)
  if (endcardEnabled && frame >= endcardStart) return "endcard";
  if (heroEnabled && frame < openFrames) return "hero_open";
  if (heroEnabled && frame >= closeStart) return "hero_close";
  return "none";
}

// ══════════════════════════════════════════════════════════════
// 1. Hero Brand Mark — dead center, bookend only
// ══════════════════════════════════════════════════════════════
const HeroBrandMark: React.FC<{
  frame: number;
  totalFrames: number;
  openFrames: number;
  closeFrames: number;
  scale: number;
  heroSize: number;
  heroMark: HeroMarkId;
  compScale: number;
}> = ({ frame, totalFrames, openFrames, closeFrames, scale, heroSize: baseSizeProp, heroMark, compScale }) => {
  const s = compScale;
  const heroSize = snap(baseSizeProp * scale * s);
  const plateSize = snap(heroSize * 1.2);
  const plateRadius = snap(22 * s);

  // ── Phase detection ──
  const closeStart = totalFrames - closeFrames;
  const isOpen = frame < openFrames;
  const isClose = frame >= closeStart;

  if (!isOpen && !isClose) return null;

  let opacity = 0;
  let scaleAnim = 0.92;
  let yDrift = 10;

  if (isOpen) {
    // OPEN: opacity 0→1, scale 0.92→1.0 (easeOutCubic), y drift +10→0
    const t = clamp(frame / openFrames, 0, 1);
    const eased = easeOutCubic(t);
    opacity = eased;
    scaleAnim = 0.92 + 0.08 * eased;
    yDrift = 10 * (1 - eased);
  } else {
    // CLOSE: opacity 1→0, scale 1.0→1.06, y drift 0→-12
    const t = clamp((frame - closeStart) / closeFrames, 0, 1);
    const eased = easeInCubic(t);
    opacity = 1 - eased;
    scaleAnim = 1 + 0.06 * eased;
    yDrift = -12 * eased;
  }

  if (opacity < 0.01) return null;

  // ── Optical nudge for current hero mark (logo element level) ──
  const nudge = OPTICAL_NUDGE[heroMark];
  const nudgeX = snap(nudge.x * s);
  const nudgeY = snap(nudge.y * s);

  return (
    <div
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        transform: `translate(-50%, -50%) translateY(${yDrift}px) scale(${scaleAnim}) translate3d(0,0,0)`,
        display: "grid",
        placeItems: "center",
        ...SAFE_LAYER,
        opacity,
        willChange: "transform, opacity",
      }}
    >
      {/* Backing plate — GPU-proof, stable */}
      <div
        style={{
          position: "absolute",
          width: plateSize,
          height: plateSize,
          borderRadius: plateRadius,
          background: "rgba(0,0,0,0.45)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.05)",
          transform: "translate3d(0,0,0)",
          filter: "none",
          mixBlendMode: "normal" as const,
          backfaceVisibility: "hidden" as const,
        }}
      />
      {/* Logo element — optical nudge applied here, NOT on wrapper */}
      <div
        style={{
          position: "relative",
          transform: `translate3d(${nudgeX}px, ${nudgeY}px, 0)`,
          filter: "none",
          mixBlendMode: "normal" as const,
          backfaceVisibility: "hidden" as const,
        }}
      >
        {heroMark === "procedural" ? (
          <FullDigitalTileLogo
            size={heroSize}
            gap={snap(3 * s)}
            radius={snap(3 * s)}
            color="#FFFFFF"
            glowColor="#94f33f"
          />
        ) : (
          <Img
            src={HERO_MARK_SRC[heroMark]}
            style={{
              width: heroSize,
              height: heroSize,
              display: "block",
              ...SAFE_LAYER,
              opacity: 1,
              imageRendering: "auto" as const,
            }}
          />
        )}
      </div>
    </div>
  );
};

// ══════════════════════════════════════════════════════════════
// 2. Endcard Lockup — perfect bottom center
// ══════════════════════════════════════════════════════════════
const EndcardLockup: React.FC<{
  frame: number;
  totalFrames: number;
  showLastFrames: number;
  bottomOffset: number;
  compScale: number;
}> = ({ frame, totalFrames, showLastFrames, bottomOffset, compScale }) => {
  const s = compScale;

  const lockupStart = totalFrames - showLastFrames;
  if (frame < lockupStart) return null;

  // Fade in over 12 frames
  const t = clamp((frame - lockupStart) / 12, 0, 1);
  const opacity = easeOutCubic(t) * 0.65;

  const wordmarkH = snap(16 * s);
  const bottomY = snap(bottomOffset * s);

  return (
    <div
      style={{
        position: "absolute",
        bottom: bottomY,
        left: "50%",
        transform: "translateX(-50%) translate3d(0,0,0)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        ...SAFE_LAYER,
        opacity,
        willChange: "transform, opacity",
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
          ...SAFE_LAYER,
          opacity: 1,
          imageRendering: "auto" as const,
        }}
      />
    </div>
  );
};

// ══════════════════════════════════════════════════════════════
// Main Export
// ══════════════════════════════════════════════════════════════
export const BrandSystemOverlay: React.FC<{
  spec: MotionSpec;
}> = ({ spec }) => {
  const frame = useCurrentFrame();
  const { height: compH } = useVideoConfig();

  const totalFrames = spec.durationInFrames;
  const compScale = compH / 1920;

  // Merge spec-level config with defaults
  const cfg: BrandSystemConfig = spec.brandSystem ?? {};

  const endcardStyle = cfg.endcard?.style ?? "lockupA";
  // logoOnly mode: hero is ALWAYS disabled (no logo at start)
  const heroEnabled = endcardStyle === "logoOnly" ? false : (cfg.hero?.enabled ?? true);
  const heroMark = cfg.hero?.heroMark ?? DEFAULT_HERO_MARK;
  const heroOpenFrames = cfg.hero?.openFrames ?? DEFAULT_HERO_OPEN_FRAMES;
  const heroCloseFrames = cfg.hero?.closeFrames ?? DEFAULT_HERO_CLOSE_FRAMES;
  const heroScale = cfg.hero?.scale ?? DEFAULT_HERO_SCALE;
  const heroSize = cfg.hero?.size ?? DEFAULT_HERO_SIZE;

  const endcardEnabled = cfg.endcard?.enabled ?? true;
  const showLastFrames = cfg.endcard?.showLastFrames ?? DEFAULT_ENDCARD_SHOW_LAST_FRAMES;
  const bottomOffset = cfg.endcard?.bottomOffset ?? DEFAULT_ENDCARD_BOTTOM_OFFSET;
  const endcardHeroMark = cfg.endcard?.heroMark ?? heroMark;
  const endcardLogoSize = cfg.endcard?.size ?? heroSize;

  // ── Brand state gate: single source of truth ──
  // Priority: endcard wins (hero off when endcard on). Never both.
  const phase = getBrandPhase(frame, totalFrames, cfg);

  const showHero = heroEnabled && (phase === "hero_open" || phase === "hero_close");
  const showEndcard = endcardEnabled && phase === "endcard";

  // LogoOnly outro: compute outroFrame (frames elapsed since endcard start)
  const endcardStart = totalFrames - showLastFrames;
  const outroFrame = frame - endcardStart;

  return (
    <AbsoluteFill
      style={{
        zIndex: 9999,
        pointerEvents: "none",
        ...SAFE_LAYER,
      }}
    >
      {/* Layer 1: Hero brand mark (bookend open + close, dead center) */}
      {showHero ? (
        <HeroBrandMark
          frame={frame}
          totalFrames={totalFrames}
          openFrames={heroOpenFrames}
          closeFrames={heroCloseFrames}
          scale={heroScale}
          heroSize={heroSize}
          heroMark={heroMark}
          compScale={compScale}
        />
      ) : null}

      {/* Layer 2: Endcard — logoOnly or classic lockup */}
      {showEndcard && endcardStyle === "logoOnly" ? (
        <LogoOnlyOutro
          outroFrame={outroFrame}
          compScale={compScale}
          heroMark={endcardHeroMark}
          logoSize={endcardLogoSize}
        />
      ) : showEndcard ? (
        <EndcardLockup
          frame={frame}
          totalFrames={totalFrames}
          showLastFrames={showLastFrames}
          bottomOffset={bottomOffset}
          compScale={compScale}
        />
      ) : null}
    </AbsoluteFill>
  );
};

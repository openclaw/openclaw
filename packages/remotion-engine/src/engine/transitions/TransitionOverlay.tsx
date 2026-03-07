/**
 * TransitionOverlay — Full-screen matte transitions.
 *
 * Supported types:
 * - wipe: Full-screen matte sweeping in a direction with feathered edge + glow
 * - sweep: Diagonal clip-path reveal with feathered edge + shadow
 * - dipFade: Cinematic dip-to-near-black with blur (replaces old "glitch")
 * - crossfade: Clean dissolve with subtle blur and anti-banding grain
 *
 * HARD RULES:
 * - Never use mixBlendMode (causes banding with gradient BG layers)
 * - Never use noise textures or repeating-linear-gradient noise
 * - Never transition the background stack — only scene containers
 * - Use solid dipColor (never noise) for mid-dip
 * - Add subtle grain (0.08–0.12) during dip to prevent color banding
 * - Use integer pixel rounding to avoid subpixel flicker
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import {
  EnhancedTransitionSpec,
  TransitionSpec,
} from "../parser/MotionSpecTypes";
import { clamp, resolveEasing } from "../motion/easings";

// ── Legacy → Enhanced upgrade ──
export function legacyToEnhanced(old: TransitionSpec): EnhancedTransitionSpec {
  // Route legacy "glitch" to clean dipFade
  if (old.type === "glitch") {
    return {
      type: "dipFade",
      coverage: "full",
      duration: old.duration,
      dipColor: "#060608",
      easing: "easeInOutCubic",
      out: { opacityTo: 0, blurToPx: 6, scaleTo: 1.01 },
      mid: { holdFrames: 2, dipOpacity: 1.0 },
      in: { opacityFrom: 0, blurFromPx: 6, scaleFrom: 1.01 },
      antiBanding: { grainOpacity: 0.10, dither: true },
    };
  }

  return {
    type: old.type,
    coverage: "full",
    direction: old.type === "sweep" ? "diagUp" : "leftToRight",
    duration: old.duration,
    overscanPx: 160,
    featherPx: 44,
    easing: "easeInOutCubic",
    addGlowEdge: true,
    edgeGlowOpacity: 0.22,
  };
}

// ── Main component ──
export const TransitionOverlay: React.FC<{
  spec: EnhancedTransitionSpec;
  green: string;
  width: number;
  height: number;
}> = ({ spec, green, width, height }) => {
  const f = useCurrentFrame();
  const easeFn = resolveEasing(spec.easing);
  const t = easeFn(clamp(f / Math.max(1, spec.duration - 1), 0, 1));

  if (spec.type === "wipe") return <WipeMatte t={t} spec={spec} green={green} w={width} h={height} />;
  if (spec.type === "sweep") return <SweepMatte t={t} spec={spec} green={green} w={width} h={height} />;
  if (spec.type === "crossfade") return <CrossfadeMatte t={t} spec={spec} />;
  // dipFade is default — also catches legacy "glitch" that got remapped
  return <DipFadeMatte t={t} f={f} spec={spec} />;
};

// ── WIPE: Full-screen matte sweeping left→right (or other direction) ──
const WipeMatte: React.FC<{
  t: number;
  spec: EnhancedTransitionSpec;
  green: string;
  w: number;
  h: number;
}> = ({ t, spec, green, w, h }) => {
  const overscan = spec.overscanPx ?? 160;
  const feather = spec.featherPx ?? 44;
  const dir = spec.direction ?? "leftToRight";
  const glowOn = spec.addGlowEdge ?? true;
  const glowAlpha = spec.edgeGlowOpacity ?? 0.22;

  const isHorizontal = dir === "leftToRight" || dir === "rightToLeft";
  const dim = isHorizontal ? w : h;
  const total = dim + overscan * 2;

  let edgePos: number;
  if (dir === "leftToRight" || dir === "topToBottom") {
    edgePos = Math.round(-overscan + t * total);
  } else {
    edgePos = Math.round(dim + overscan - t * total);
  }

  const matteStyle: React.CSSProperties = {
    position: "absolute",
    background: "#0B0B0F",
  };

  const featherStyle: React.CSSProperties = {
    position: "absolute",
  };

  const glowStyle: React.CSSProperties = {
    position: "absolute",
    opacity: glowAlpha * (1 - Math.abs(t - 0.5) * 1.2),
  };

  if (isHorizontal) {
    const isLTR = dir === "leftToRight";
    Object.assign(matteStyle, {
      top: -overscan,
      bottom: -overscan,
      left: isLTR ? -overscan : edgePos + feather,
      right: isLTR ? w - edgePos + feather : -overscan,
    });
    Object.assign(featherStyle, {
      top: -overscan,
      bottom: -overscan,
      left: edgePos - Math.round(feather / 2),
      width: feather,
      background: isLTR
        ? `linear-gradient(to right, #0B0B0F, transparent)`
        : `linear-gradient(to left, #0B0B0F, transparent)`,
    });
    Object.assign(glowStyle, {
      top: -overscan,
      bottom: -overscan,
      left: edgePos - 30,
      width: 60,
      background: `radial-gradient(ellipse at center, ${green}, transparent)`,
      filter: "blur(20px)",
    });
  } else {
    const isTTB = dir === "topToBottom";
    Object.assign(matteStyle, {
      left: -overscan,
      right: -overscan,
      top: isTTB ? -overscan : edgePos + feather,
      bottom: isTTB ? h - edgePos + feather : -overscan,
    });
    Object.assign(featherStyle, {
      left: -overscan,
      right: -overscan,
      top: edgePos - Math.round(feather / 2),
      height: feather,
      background: isTTB
        ? `linear-gradient(to bottom, #0B0B0F, transparent)`
        : `linear-gradient(to top, #0B0B0F, transparent)`,
    });
    Object.assign(glowStyle, {
      left: -overscan,
      right: -overscan,
      top: edgePos - 30,
      height: 60,
      background: `radial-gradient(ellipse at center, ${green}, transparent)`,
      filter: "blur(20px)",
    });
  }

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      <div style={matteStyle} />
      <div style={featherStyle} />
      {glowOn ? <div style={glowStyle} /> : null}
    </AbsoluteFill>
  );
};

// ── SWEEP: Diagonal full-screen matte ──
const SweepMatte: React.FC<{
  t: number;
  spec: EnhancedTransitionSpec;
  green: string;
  w: number;
  h: number;
}> = ({ t, spec, green }) => {
  const feather = spec.featherPx ?? 52;
  const shadowOn = spec.addShadow ?? true;
  const shadowAlpha = spec.shadowOpacity ?? 0.28;
  const glowOn = spec.addGlowEdge ?? false;
  const glowAlpha = spec.edgeGlowOpacity ?? 0.18;
  const dir = spec.direction ?? "diagUp";

  const extra = 0.15;
  const sweep = -extra + t * (1 + extra * 2);

  let clipPath: string;
  if (dir === "diagUp" || dir === "topToBottom") {
    const y1 = clamp(sweep + 0.35, -0.5, 1.5);
    const y2 = clamp(sweep - 0.35, -0.5, 1.5);
    clipPath = `polygon(
      ${-extra * 100}% ${y1 * 100}%,
      ${(1 + extra) * 100}% ${y2 * 100}%,
      ${(1 + extra) * 100}% ${(1 + extra) * 100}%,
      ${-extra * 100}% ${(1 + extra) * 100}%
    )`;
  } else {
    const y1 = clamp(1 - sweep + 0.35, -0.5, 1.5);
    const y2 = clamp(1 - sweep - 0.35, -0.5, 1.5);
    clipPath = `polygon(
      ${-extra * 100}% ${-extra * 100}%,
      ${(1 + extra) * 100}% ${-extra * 100}%,
      ${(1 + extra) * 100}% ${y1 * 100}%,
      ${-extra * 100}% ${y2 * 100}%
    )`;
  }

  const angle = dir === "diagUp" || dir === "topToBottom" ? -25 : 25;
  const bandPos = sweep * 100;

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "#0B0B0F",
          clipPath,
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: -100,
          background: `linear-gradient(${angle}deg,
            transparent ${bandPos - feather / 4}%,
            rgba(11,11,15,0.6) ${bandPos}%,
            transparent ${bandPos + feather / 4}%)`,
        }}
      />
      {shadowOn ? (
        <div
          style={{
            position: "absolute",
            inset: -100,
            background: `linear-gradient(${angle}deg,
              transparent ${bandPos - 8}%,
              rgba(0,0,0,${shadowAlpha}) ${bandPos}%,
              transparent ${bandPos + 8}%)`,
            filter: "blur(12px)",
          }}
        />
      ) : null}
      {glowOn ? (
        <div
          style={{
            position: "absolute",
            inset: -100,
            background: `linear-gradient(${angle}deg,
              transparent ${bandPos - 3}%,
              ${green} ${bandPos}%,
              transparent ${bandPos + 3}%)`,
            opacity: glowAlpha * (1 - Math.abs(t - 0.5) * 1.4),
            filter: "blur(18px)",
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

// ── DIP FADE: Cinematic dip-to-near-black with blur ──
// Replaces the old GlitchMatte. Deterministic, no noise, no blend modes.
//
// Timeline:
//   0% → dipStart:  outgoing fades out + blurs + slight scale
//   dipStart → dipEnd: solid near-black dip (holdFrames)
//   dipEnd → 100%:  incoming fades in + unblurs + slight scale
const DipFadeMatte: React.FC<{
  t: number;
  f: number;
  spec: EnhancedTransitionSpec;
}> = ({ t, f, spec }) => {
  const dipColor = spec.dipColor ?? "#060608";
  const outSpec = spec.out ?? { opacityTo: 0, blurToPx: 6, scaleTo: 1.01 };
  const midSpec = spec.mid ?? { holdFrames: 2, dipOpacity: 1.0 };
  const inSpec = spec.in ?? { opacityFrom: 0, blurFromPx: 6, scaleFrom: 1.01 };
  const abGrain = spec.antiBanding?.grainOpacity ?? 0.10;

  const dur = Math.max(1, spec.duration);
  const holdFrames = midSpec.holdFrames ?? 2;

  // Phase boundaries (normalized 0–1)
  const dipStartNorm = 0.42;
  const dipEndNorm = dipStartNorm + holdFrames / dur;

  // Dip layer opacity: ramps up to dipStart, holds during mid, ramps down after
  let dipOpacity: number;
  if (t < dipStartNorm) {
    // Fade in: 0 → dipOpacity over first phase
    const phase = t / dipStartNorm;
    dipOpacity = phase * (midSpec.dipOpacity ?? 1.0);
  } else if (t < dipEndNorm) {
    // Hold at full dip
    dipOpacity = midSpec.dipOpacity ?? 1.0;
  } else {
    // Fade out: dipOpacity → 0
    const phase = (t - dipEndNorm) / (1 - dipEndNorm);
    dipOpacity = (1 - phase) * (midSpec.dipOpacity ?? 1.0);
  }

  // Blur envelope: peaks at dipStart, returns to 0 at edges
  const blurOut = outSpec.blurToPx ?? 6;
  const blurIn = inSpec.blurFromPx ?? 6;
  let blurPx: number;
  if (t < dipStartNorm) {
    blurPx = (t / dipStartNorm) * blurOut;
  } else if (t < dipEndNorm) {
    blurPx = Math.max(blurOut, blurIn);
  } else {
    blurPx = (1 - (t - dipEndNorm) / (1 - dipEndNorm)) * blurIn;
  }

  // Anti-banding grain: very subtle, using a CSS radial gradient (NOT noise texture)
  // This breaks up color banding during the dip without introducing texture artifacts
  const grainSeed1 = Math.round(Math.sin(f * 1.3) * 500 + 500);
  const grainSeed2 = Math.round(Math.cos(f * 2.1) * 500 + 500);

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {/* Dip color layer — solid color, never noise */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: dipColor,
          opacity: clamp(dipOpacity, 0, 1),
        }}
      />

      {/* Blur overlay — applies to scene content behind via backdrop-filter */}
      {blurPx > 0.5 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backdropFilter: `blur(${Math.round(blurPx)}px)`,
            WebkitBackdropFilter: `blur(${Math.round(blurPx)}px)`,
          }}
        />
      ) : null}

      {/* Anti-banding grain — very subtle solid-color-based dots */}
      {abGrain > 0.01 && dipOpacity > 0.1 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: abGrain * clamp(dipOpacity, 0, 1),
            background: `radial-gradient(circle at ${grainSeed1 % 100}% ${grainSeed2 % 100}%, rgba(255,255,255,0.12) 0%, transparent 40%),
                         radial-gradient(circle at ${(grainSeed1 + 37) % 100}% ${(grainSeed2 + 61) % 100}%, rgba(255,255,255,0.08) 0%, transparent 35%)`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

// ── CROSSFADE: Clean dissolve with subtle blur ──
// No blend modes, no noise. Just opacity + optional blur envelope.
const CrossfadeMatte: React.FC<{
  t: number;
  spec: EnhancedTransitionSpec;
}> = ({ t, spec }) => {
  const outSpec = spec.out ?? { opacityTo: 0, blurToPx: 3 };
  const inSpec = spec.in ?? { opacityFrom: 0, blurFromPx: 3 };
  const abGrain = spec.antiBanding?.grainOpacity ?? 0.08;

  // Crossfade: scene A fades out while scene B fades in simultaneously
  // We render a semi-transparent dark overlay that peaks at 0.5
  const peakOpacity = 0.35;
  const overlayOpacity = peakOpacity * (1 - Math.abs(t - 0.5) * 2);

  // Blur envelope peaks at midpoint
  const maxBlur = Math.max(outSpec.blurToPx ?? 3, inSpec.blurFromPx ?? 3);
  const blurPx = maxBlur * (1 - Math.abs(t - 0.5) * 2);

  return (
    <AbsoluteFill style={{ pointerEvents: "none", overflow: "hidden" }}>
      {/* Soft darkening at midpoint */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "#0B0B0F",
          opacity: clamp(overlayOpacity, 0, 1),
        }}
      />

      {/* Blur during crossfade */}
      {blurPx > 0.5 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            backdropFilter: `blur(${Math.round(blurPx)}px)`,
            WebkitBackdropFilter: `blur(${Math.round(blurPx)}px)`,
          }}
        />
      ) : null}

      {/* Anti-banding grain */}
      {abGrain > 0.01 && overlayOpacity > 0.05 ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: abGrain * clamp(overlayOpacity * 3, 0, 1),
            background: `radial-gradient(circle at 50% 50%, rgba(255,255,255,0.06) 0%, transparent 50%)`,
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

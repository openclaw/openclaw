/**
 * GlobalCursorOverlay — Composition-level cursor. Single source of truth.
 *
 * z-index 90 (above UI + captions, below brand lockup).
 *
 * Features:
 * - 1.75x size (big, eye-catching, mobile-readable)
 * - NEVER still — continuous Lissajous drift overlaid on all motion
 * - Pre-click hover orbit (10 frames of tightening circular motion)
 * - Click: scale-down + bounce-back + expanding ring + ripple
 * - Synthetic click scheduler: if no real tap for >24 frames, clicks a
 *   secondary safe target (toggle label, pill, header) to keep energy up
 * - Reads all scenes' propsTimeline tapTargets for global cursor track
 * - Idle: gentle drift + periodic "reposition" to next area of interest
 */
import React from "react";
import { useCurrentFrame, useVideoConfig, AbsoluteFill } from "remotion";
import type { MotionSpec } from "../parser/MotionSpecTypes";
import { getBrandPhase } from "./BrandSystemOverlay";
import { tapTargetToCardCoords } from "../ui/maps/tapTargetToCoords";
import { clamp, easeInOutCubic, easeOutCubic, easeOutBack } from "../motion/easings";

// ── Constants ──
const MOVE_FRAMES = 12;
const CLICK_DOWN_FRAMES = 3;
const CLICK_BOUNCE_FRAMES = 5;
const CURSOR_BASE_SCALE = 2.25; // 125% bigger — big, eye-catching, mobile-readable

// Continuous drift — cursor is NEVER perfectly still (Lissajous pattern)
const DRIFT_SPEED_A = 1 / 7;
const DRIFT_SPEED_B = 1 / 9;
const DRIFT_SPEED_C = 1 / 13;
const DRIFT_AMP_X = 4;
const DRIFT_AMP_Y = 3;

// Idle drift (when no targets nearby) — larger, more noticeable
const IDLE_DRIFT_AMP = 10;
const IDLE_DRIFT_SPEED = 0.05;

// Pre-click hover orbit
const ORBIT_LEAD_FRAMES = 10;
const ORBIT_RADIUS = 5;

// Synthetic click scheduler
const SYNTHETIC_GAP_THRESHOLD = 24; // frames without a real click → generate synthetic

// Safe synthetic tap targets (in priority order)
const SYNTHETIC_TARGETS = [
  "toggle.clips",
  "toggle.gifs",
  "toggle.thumbnails",
  "aspect.9:16",
  "aspect.1:1",
  "button.start",
];

type GlobalTarget = {
  x: number;
  y: number;
  at: number;
  click: boolean;
  synthetic?: boolean;
};

/**
 * Extract all cursor targets from spec, converting scene-local frames
 * to absolute composition frames, card-local coords to comp-space.
 * Also injects synthetic clicks during idle gaps.
 */
function extractGlobalTargets(spec: MotionSpec): GlobalTarget[] {
  const targets: GlobalTarget[] = [];
  const compW = spec.width;
  const compH = spec.height;

  const cardW = 820;
  const cardX = Math.round((compW - cardW) / 2);
  const estimatedCardH = 550;
  const cardY = Math.round((compH - estimatedCardH) / 2);

  for (const scene of spec.scenes) {
    if (!scene.elements) continue;
    for (const el of scene.elements) {
      if (el.kind !== "uiCard" || !el.propsTimeline) continue;

      const options = (el.uiOptions ?? {}) as Record<string, unknown>;
      const toggleLabels = (options.outputs as string[]) ?? [
        "CLIPS", "GIFS", "THUMBNAILS", "CANVAS",
      ];
      const aspectPills = (options.aspectToggles as string[]) ?? [
        "9:16", "1:1", "16:9",
      ];

      for (const entry of el.propsTimeline) {
        if (!entry.props.tapTarget) continue;
        const cardCoords = tapTargetToCardCoords(
          entry.props.tapTarget,
          toggleLabels,
          aspectPills,
        );
        const isClick = !!(entry.props.tap || entry.props.pressed);
        targets.push({
          x: cardX + cardCoords.x,
          y: cardY + cardCoords.y,
          at: scene.from + entry.at,
          click: isClick,
        });
      }
    }
  }

  targets.sort((a, b) => a.at - b.at);

  // ── Inject synthetic clicks during idle gaps ──
  const enhanced: GlobalTarget[] = [];
  let syntheticIdx = 0;

  for (let i = 0; i < targets.length; i++) {
    enhanced.push(targets[i]);

    if (i < targets.length - 1) {
      const gap = targets[i + 1].at - targets[i].at;
      if (gap > SYNTHETIC_GAP_THRESHOLD) {
        // Fill the gap with a synthetic tap
        const synTarget = SYNTHETIC_TARGETS[syntheticIdx % SYNTHETIC_TARGETS.length];
        syntheticIdx++;
        const synCoords = tapTargetToCardCoords(synTarget);
        const synFrame = targets[i].at + Math.round(gap * 0.5);
        enhanced.push({
          x: cardX + synCoords.x,
          y: cardY + synCoords.y,
          at: synFrame,
          click: true,
          synthetic: true,
        });
      }
    }
  }

  // Also fill gap before first target if there's a long wait
  if (targets.length > 0 && targets[0].at > SYNTHETIC_GAP_THRESHOLD + 12) {
    const synTarget = SYNTHETIC_TARGETS[syntheticIdx % SYNTHETIC_TARGETS.length];
    const synCoords = tapTargetToCardCoords(synTarget);
    enhanced.unshift({
      x: cardX + synCoords.x,
      y: cardY + synCoords.y,
      at: Math.round(targets[0].at * 0.4),
      click: true,
      synthetic: true,
    });
  }

  enhanced.sort((a, b) => a.at - b.at);
  return enhanced;
}

/** Continuous Lissajous micro-drift — never stops */
function continuousDrift(frame: number): { dx: number; dy: number } {
  return {
    dx: Math.sin(frame * DRIFT_SPEED_A) * DRIFT_AMP_X +
        Math.sin(frame * DRIFT_SPEED_C) * 1.5,
    dy: Math.cos(frame * DRIFT_SPEED_B) * DRIFT_AMP_Y +
        Math.cos(frame * DRIFT_SPEED_C * 0.7) * 1,
  };
}

/** Pre-click hover orbit — tightening circular motion */
function hoverOrbit(
  frame: number,
  target: GlobalTarget,
): { ox: number; oy: number } | null {
  const framesToClick = target.at - frame;
  if (framesToClick <= 0 || framesToClick > ORBIT_LEAD_FRAMES) return null;
  const orbitT = 1 - framesToClick / ORBIT_LEAD_FRAMES;
  const radius = ORBIT_RADIUS * (1 - orbitT * 0.65);
  const angle = orbitT * Math.PI * 3.5;
  return {
    ox: Math.cos(angle) * radius,
    oy: Math.sin(angle) * radius,
  };
}

/** Resolve cursor base position for a given absolute frame. */
function resolveGlobalCursor(
  frame: number,
  targets: GlobalTarget[],
  compW: number,
  compH: number,
): { x: number; y: number; clickElapsed: number; isSynthetic: boolean } {
  const restX = compW * 0.62;
  const restY = compH * 0.52;

  if (targets.length === 0) {
    const d = continuousDrift(frame);
    const idleX = Math.sin(frame * IDLE_DRIFT_SPEED) * IDLE_DRIFT_AMP;
    const idleY = Math.cos(frame * IDLE_DRIFT_SPEED * 0.7) * IDLE_DRIFT_AMP * 0.6;
    return {
      x: restX + idleX + d.dx,
      y: restY + idleY + d.dy,
      clickElapsed: -999,
      isSynthetic: false,
    };
  }

  const firstTarget = targets[0];

  // Before first target: active idle drift
  if (frame < firstTarget.at - MOVE_FRAMES) {
    const d = continuousDrift(frame);
    const idleX = Math.sin(frame * IDLE_DRIFT_SPEED) * IDLE_DRIFT_AMP;
    const idleY = Math.cos(frame * IDLE_DRIFT_SPEED * 0.7) * IDLE_DRIFT_AMP * 0.6;
    return {
      x: restX + idleX + d.dx,
      y: restY + idleY + d.dy,
      clickElapsed: -999,
      isSynthetic: false,
    };
  }

  // Approaching first target
  if (frame < firstTarget.at) {
    const moveStart = firstTarget.at - MOVE_FRAMES;
    const rawT = clamp((frame - moveStart) / MOVE_FRAMES, 0, 1);
    const easedT = easeInOutCubic(rawT);
    const d = continuousDrift(frame);
    const orbit = hoverOrbit(frame, firstTarget);
    return {
      x: restX + (firstTarget.x - restX) * easedT + d.dx + (orbit?.ox ?? 0),
      y: restY + (firstTarget.y - restY) * easedT + d.dy + (orbit?.oy ?? 0),
      clickElapsed: -999,
      isSynthetic: false,
    };
  }

  // Find current and next target
  let currTarget = firstTarget;
  let lastClickAt = -999;
  let lastWasSynthetic = false;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.at <= frame) {
      currTarget = t;
      if (t.click) {
        lastClickAt = t.at;
        lastWasSynthetic = !!t.synthetic;
      }
    } else {
      // Interpolate toward next target
      const moveStart = t.at - MOVE_FRAMES;
      if (frame >= moveStart) {
        const rawT = clamp((frame - moveStart) / MOVE_FRAMES, 0, 1);
        const easedT = easeInOutCubic(rawT);
        const d = continuousDrift(frame);
        const orbit = hoverOrbit(frame, t);
        return {
          x: currTarget.x + (t.x - currTarget.x) * easedT + d.dx + (orbit?.ox ?? 0),
          y: currTarget.y + (t.y - currTarget.y) * easedT + d.dy + (orbit?.oy ?? 0),
          clickElapsed: frame - lastClickAt,
          isSynthetic: lastWasSynthetic,
        };
      }
      // Between targets: hold at current with active drift
      const d = continuousDrift(frame);
      return {
        x: currTarget.x + d.dx,
        y: currTarget.y + d.dy,
        clickElapsed: frame - lastClickAt,
        isSynthetic: lastWasSynthetic,
      };
    }
  }

  // Past last target: drift at last position, then return to rest
  const framesAfterLast = frame - targets[targets.length - 1].at;
  const returnStart = 24;
  const d = continuousDrift(frame);

  if (framesAfterLast < returnStart) {
    return {
      x: currTarget.x + d.dx,
      y: currTarget.y + d.dy,
      clickElapsed: frame - lastClickAt,
      isSynthetic: lastWasSynthetic,
    };
  }

  const returnT = clamp((framesAfterLast - returnStart) / 24, 0, 1);
  const returnEased = easeInOutCubic(returnT);
  return {
    x: currTarget.x + (restX - currTarget.x) * returnEased + d.dx,
    y: currTarget.y + (restY - currTarget.y) * returnEased + d.dy,
    clickElapsed: frame - lastClickAt,
    isSynthetic: lastWasSynthetic,
  };
}

/** Big white arrow cursor SVG — 1.75x base scale */
const ArrowCursor: React.FC<{ scale: number }> = ({ scale }) => (
  <svg
    width="26"
    height="32"
    viewBox="0 0 26 32"
    fill="none"
    style={{
      transform: `rotate(-12deg) scale(${scale * CURSOR_BASE_SCALE})`,
      transformOrigin: "3px 1px",
      filter: "drop-shadow(0 4px 12px rgba(0,0,0,0.55)) drop-shadow(0 1px 3px rgba(0,0,0,0.3))",
    }}
  >
    <path
      d="M2 1L2 24L8 18.5L13.5 27L17 25L11.5 16L19 16L2 1Z"
      fill="white"
      stroke="rgba(0,0,0,0.3)"
      strokeWidth="1.4"
    />
  </svg>
);

export const GlobalCursorOverlay: React.FC<{
  spec: MotionSpec;
}> = ({ spec }) => {
  // ── ALL HOOKS FIRST — unconditional, stable count every render ──
  const frame = useCurrentFrame();
  const { width: compW, height: compH } = useVideoConfig();
  const targets = React.useMemo(() => extractGlobalTargets(spec), [spec]);

  // ── Visibility checks AFTER all hooks ──
  if (spec.cursor && spec.cursor.enabled === false) return null;

  // Hide cursor during logoOnly outro (endcard phase when style is logoOnly)
  const endcardStyle = spec.brandSystem?.endcard?.style ?? "lockupA";
  if (endcardStyle === "logoOnly") {
    const phase = getBrandPhase(frame, spec.durationInFrames, spec.brandSystem);
    if (phase === "endcard") return null;
  }

  const state = resolveGlobalCursor(frame, targets, compW, compH);

  // Click animation: scale down then bounce back
  let cursorScale = 1;
  if (state.clickElapsed >= 0 && state.clickElapsed < CLICK_DOWN_FRAMES) {
    const rawT = clamp(state.clickElapsed / CLICK_DOWN_FRAMES, 0, 1);
    cursorScale = 1 - 0.22 * easeOutCubic(rawT);
  } else if (
    state.clickElapsed >= CLICK_DOWN_FRAMES &&
    state.clickElapsed < CLICK_DOWN_FRAMES + CLICK_BOUNCE_FRAMES
  ) {
    const rawT = clamp(
      (state.clickElapsed - CLICK_DOWN_FRAMES) / CLICK_BOUNCE_FRAMES,
      0,
      1,
    );
    cursorScale = 0.78 + 0.22 * easeOutBack(rawT);
  }

  // Click ring (bigger for bigger cursor)
  let ringRadius = 0;
  let ringOpacity = 0;
  if (state.clickElapsed >= 0 && state.clickElapsed < 14) {
    const ringT = clamp(state.clickElapsed / 14, 0, 1);
    ringRadius = easeOutCubic(ringT) * 36;
    ringOpacity = (state.isSynthetic ? 0.2 : 0.35) * (1 - ringT);
  }

  return (
    <AbsoluteFill style={{ zIndex: 90, pointerEvents: "none" }}>
      {/* Click ring */}
      {ringOpacity > 0 ? (
        <div
          style={{
            position: "absolute",
            left: Math.round(state.x - ringRadius),
            top: Math.round(state.y - ringRadius),
            width: Math.round(ringRadius * 2),
            height: Math.round(ringRadius * 2),
            borderRadius: "50%",
            border: `2.5px solid rgba(255,255,255,${ringOpacity})`,
            background: `radial-gradient(circle, rgba(255,255,255,${ringOpacity * 0.35}) 0%, transparent 70%)`,
          }}
        />
      ) : null}
      {/* Cursor — pixel-snapped */}
      <div
        style={{
          position: "absolute",
          left: Math.round(state.x),
          top: Math.round(state.y),
          transform: "translate(-3px, -1px)",
        }}
      >
        <ArrowCursor scale={cursorScale} />
      </div>
    </AbsoluteFill>
  );
};

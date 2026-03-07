/**
 * ElementAnimator — Wraps a child element and applies enter/exit motion
 * based on ElementMotion + preset resolution.
 *
 * State machine per frame (relative to scene start):
 *   Before enter.at        → opacity 0
 *   enter.at … +dur        → animating in
 *   hold                   → fully visible
 *   exit.at … +dur         → animating out
 *   After exit             → opacity 0
 */
import React from "react";
import { useCurrentFrame } from "remotion";
import {
  ElementMotion,
  ElementMotionStep,
  ElementMotionPresetMap,
} from "../parser/MotionSpecTypes";
import { clamp, resolveEasing } from "./easings";
import { resolveElementPreset } from "./presets";

// ── Resolve a step: merge preset defaults with inline overrides ──
function resolveStep(
  step: ElementMotionStep,
  presets?: ElementMotionPresetMap,
): ElementMotionStep {
  if (!step.preset) return step;
  const base = resolveElementPreset(step.preset, presets);
  if (!base) return step;
  return { ...base, ...step }; // inline overrides win
}

// ── Compute transform + opacity for a single animation type ──
function computeEnterStyle(
  type: string,
  progress: number, // 0→1
  step: ElementMotionStep,
): React.CSSProperties {
  const dist = step.distancePx ?? 30;
  const sf = step.scaleFrom ?? 0.96;

  switch (type) {
    case "slideUpFade":
      return {
        opacity: progress,
        transform: `translateY(${(1 - progress) * dist}px)`,
      };
    case "fadeIn":
      return { opacity: progress };
    case "scaleIn":
      return {
        opacity: progress,
        transform: `scale(${sf + (1 - sf) * progress})`,
        boxShadow: step.shadowPop
          ? `0 ${20 * progress}px ${60 * progress}px rgba(0,0,0,${0.4 * progress})`
          : "none",
      };
    case "popIn":
      return {
        opacity: progress,
        transform: `scale(${sf + (1 - sf) * progress})`,
      };
    case "revealLR":
      return {
        transform: `scaleX(${progress})`,
        transformOrigin: "left center",
      };
    case "fadeSlide":
      return {
        opacity: progress,
        transform: `translateY(${(1 - progress) * dist}px)`,
      };
    default:
      return { opacity: progress };
  }
}

function computeExitStyle(
  type: string,
  progress: number, // 0→1 (0 = start exit, 1 = fully gone)
  step: ElementMotionStep,
): React.CSSProperties {
  const dist = step.distancePx ?? 18;
  const sf = step.scaleFrom ?? 0.985;

  switch (type) {
    case "slideDownFade":
      return {
        opacity: 1 - progress,
        transform: `translateY(${-progress * dist}px)`,
      };
    case "fadeOut":
      return {
        opacity: 1 - progress,
        filter: step.blur ? `blur(${step.blur * progress}px)` : undefined,
      };
    case "scaleOut":
      return {
        opacity: 1 - progress,
        transform: `scale(${1 - (1 - sf) * progress})`,
        filter: step.blur ? `blur(${step.blur * progress}px)` : undefined,
      };
    case "revealRL":
      return {
        transform: `scaleX(${1 - progress})`,
        transformOrigin: "right center",
      };
    default:
      return { opacity: 1 - progress };
  }
}

export const ElementAnimator: React.FC<{
  motion: ElementMotion;
  presets?: ElementMotionPresetMap;
  children: React.ReactNode;
}> = ({ motion, presets, children }) => {
  const frame = useCurrentFrame();

  const enterStep = resolveStep(motion.enter, presets);
  const exitStep = motion.exit ? resolveStep(motion.exit, presets) : undefined;

  const enterAt = enterStep.at;
  const enterDur = enterStep.durationFrames ?? 10;
  const enterEase = resolveEasing(enterStep.easing);
  const enterType = enterStep.type ?? "slideUpFade";

  const exitAt = exitStep?.at ?? Infinity;
  const exitDur = exitStep?.durationFrames ?? 8;
  const exitEase = exitStep ? resolveEasing(exitStep.easing) : resolveEasing();
  const exitType = exitStep?.type ?? "fadeOut";

  // State: before enter
  if (frame < enterAt) {
    return <div style={{ opacity: 0 }}>{children}</div>;
  }

  // State: entering
  if (frame < enterAt + enterDur) {
    const rawT = clamp((frame - enterAt) / Math.max(1, enterDur), 0, 1);
    const t = enterEase(rawT);
    const style = computeEnterStyle(enterType, t, enterStep);
    return <div style={style}>{children}</div>;
  }

  // State: visible (between enter end and exit start)
  if (frame < exitAt) {
    return <div style={{ opacity: 1 }}>{children}</div>;
  }

  // State: exiting
  if (exitStep && frame < exitAt + exitDur) {
    const rawT = clamp((frame - exitAt) / Math.max(1, exitDur), 0, 1);
    const t = exitEase(rawT);
    const style = computeExitStyle(exitType, t, exitStep);
    return <div style={style}>{children}</div>;
  }

  // State: after exit
  return <div style={{ opacity: 0 }}>{children}</div>;
};

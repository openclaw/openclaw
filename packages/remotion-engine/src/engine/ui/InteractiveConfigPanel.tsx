/**
 * InteractiveConfigPanel — Thin animation wrapper around ConfigureOutputCard.
 *
 * Computes smooth per-frame animation values from propsTimeline state and
 * passes them into ConfigureOutputCard's optional drivable props:
 * - Toggle knob positions (smooth slide via easeOutCubic)
 * - Track colors & opacities (smooth fade)
 * - CTA button scale + glow (press bounce via easeOutBack)
 * - Checkmark scales (pop-in via easeOutBack)
 *
 * This avoids duplicating ConfigureOutputCard's layout — all rendering
 * is delegated to the single source of truth.
 */
import React from "react";
import {
  PropsTimelineToggleState,
  PropsTimelineEntry,
} from "../parser/MotionSpecTypes";
import { clamp, easeOutCubic, easeOutBack } from "../motion/easings";
import { findToggleFlipFrame, findPressFrame, findCheckmarkFrame } from "./resolveTimeline";
import { ConfigureOutputCard } from "./ConfigureOutputCard";

// ── Animation constants ──
const KNOB_OFF = 2;
const KNOB_ON = 20;
const KNOB_TRAVEL = KNOB_ON - KNOB_OFF; // 18px
const TOGGLE_ANIM_FRAMES = 8;
const PRESS_DOWN_FRAMES = 4;
const PRESS_BOUNCE_FRAMES = 6;
const CHECKMARK_FRAMES = 6;

export const InteractiveConfigPanel: React.FC<{
  green: string;
  title: string;
  aspectPills: string[];
  toggles: string[]; // labels
  cta: string;
  // Animated state (from resolveTimeline)
  toggleStates: PropsTimelineToggleState[];
  activeAspect: number;
  pressed: boolean;
  progress: number;
  status: "idle" | "processing" | "generating" | "done";
  checkmarks: string[];
  frame: number;
  timeline: PropsTimelineEntry[];
  highlightToggleIndex?: number;
}> = ({
  green,
  title,
  aspectPills,
  toggles,
  cta,
  toggleStates,
  activeAspect,
  pressed,
  progress,
  status,
  checkmarks,
  frame,
  timeline,
  highlightToggleIndex,
}) => {
  // Build toggle label → ON state map
  const toggleMap = new Map<string, boolean>();
  for (const t of toggleStates) {
    toggleMap.set(t.label, t.on);
  }

  // ── Compute per-toggle animation sub-props ──
  const toggleOn: boolean[] = [];
  const knobPositions: number[] = [];
  const trackColors: string[] = [];
  const trackOpacities: number[] = [];
  const checkmarkScales: number[] = [];

  for (const label of toggles) {
    const isOn = toggleMap.get(label) ?? false;
    toggleOn.push(isOn);

    // Knob position: smooth slide
    const flipFrame = findToggleFlipFrame(label, timeline);
    let toggleProgress = 0;
    if (isOn && flipFrame >= 0) {
      const rawT = clamp((frame - flipFrame) / TOGGLE_ANIM_FRAMES, 0, 1);
      toggleProgress = easeOutCubic(rawT);
    } else if (isOn) {
      toggleProgress = 1; // already ON at scene start
    }
    knobPositions.push(Math.round(KNOB_OFF + KNOB_TRAVEL * toggleProgress));

    // Track color: interpolate from gray to green
    trackColors.push(
      toggleProgress > 0.01 ? green : "rgba(255,255,255,0.12)",
    );
    trackOpacities.push(
      toggleProgress > 0.01 ? 0.3 + 0.7 * toggleProgress : 1,
    );

    // Checkmark scale: pop-in
    const hasCheckmark = checkmarks.includes(label);
    let checkScale = 0;
    if (hasCheckmark) {
      const checkFrame = findCheckmarkFrame(label, timeline);
      if (checkFrame >= 0) {
        const rawT = clamp((frame - checkFrame) / CHECKMARK_FRAMES, 0, 1);
        checkScale = easeOutBack(rawT);
      } else {
        checkScale = 1;
      }
    }
    checkmarkScales.push(checkScale);
  }

  // ── CTA button press animation ──
  let ctaScale = 1;
  let ctaGlow = 0;
  const pressFrame = findPressFrame(timeline);

  if (pressFrame >= 0) {
    const elapsed = frame - pressFrame;

    if (elapsed >= 0 && elapsed < PRESS_DOWN_FRAMES) {
      // Pressing down: scale 1.0 → 0.97
      const rawT = clamp(elapsed / PRESS_DOWN_FRAMES, 0, 1);
      const t = easeOutCubic(rawT);
      ctaScale = 1 - 0.03 * t;
      ctaGlow = t;
    } else if (
      elapsed >= PRESS_DOWN_FRAMES &&
      elapsed < PRESS_DOWN_FRAMES + PRESS_BOUNCE_FRAMES
    ) {
      // Bounce back: scale 0.97 → 1.0 with overshoot
      const rawT = clamp(
        (elapsed - PRESS_DOWN_FRAMES) / PRESS_BOUNCE_FRAMES,
        0,
        1,
      );
      const t = easeOutBack(rawT);
      ctaScale = 0.97 + 0.03 * t;
      ctaGlow = 1 - rawT;
    }
  }

  // ── Map status: "processing" → "generating" for ConfigureOutputCard ──
  const cardStatus: "idle" | "generating" | "done" =
    status === "processing" ? "generating" : (status as "idle" | "generating" | "done");

  return (
    <ConfigureOutputCard
      green={green}
      title={title}
      quickStart={true}
      aspectPills={aspectPills}
      toggles={toggles}
      cta={cta}
      // Drivable state props
      activePillIndex={activeAspect}
      toggleOn={toggleOn}
      pressed={pressed}
      progress={progress}
      status={cardStatus}
      highlightToggleIndex={highlightToggleIndex}
      checkmarks={checkmarks}
      // Animation sub-props (smooth tweened values)
      knobPositions={knobPositions}
      trackColors={trackColors}
      trackOpacities={trackOpacities}
      ctaScale={ctaScale}
      ctaGlow={ctaGlow}
      checkmarkScales={checkmarkScales}
    />
  );
};

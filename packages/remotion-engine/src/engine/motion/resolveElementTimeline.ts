/**
 * resolveElementTimeline — Computes IN / HOLD / OUT windows for every
 * element in a scene, enforcing the "Element Choreography" rule:
 *
 *   1. Every element has its own IN, HOLD, OUT window.
 *   2. Auto-stagger by kind priority:
 *        badge → headline → subhead → accentUnderline →
 *        uiCard → listItem → gridItem → cta → support → logo
 *   3. OUT begins before transitionOut:
 *        outStart = sceneDuration - transitionDur - elementOutLeadFrames
 *
 * This eliminates "wipe with nothing moving" — elements animate OUT *before*
 * the scene matte sweeps in, so you see choreography, not just a wipe.
 *
 * Use case: Called by the spec generator / validator to auto-compute or
 * audit element `motion.enter.at` / `motion.exit.at` timings.
 */
import type {
  ElementDef,
  ElementKind,
  SceneSpec,
} from "../parser/MotionSpecTypes";

// ── Kind → stagger priority (lower = appears first) ──
const KIND_PRIORITY: Record<ElementKind, number> = {
  badge: 0,
  headline: 1,
  subhead: 2,
  accentUnderline: 3,
  icon: 4,
  uiCard: 5,
  listItem: 6,
  gridItem: 6,
  cta: 7,
  support: 8,
  logo: 9,
  caption: 10,
};

// ── Style profile ──
export type ChoreographyProfile = {
  /** Frames between each element's IN start */
  staggerFrames: number;
  /** Frames of cushion before transition where OUT must start */
  elementOutLeadFrames: number;
  /** Default enter duration if not set on element */
  defaultEnterDur: number;
  /** Default exit duration if not set on element */
  defaultExitDur: number;
  /** Minimum hold time in frames */
  minHoldFrames: number;
};

export const DEFAULT_PROFILE: ChoreographyProfile = {
  staggerFrames: 6,
  elementOutLeadFrames: 4,
  defaultEnterDur: 10,
  defaultExitDur: 8,
  minHoldFrames: 12,
};

export type ElementTimeline = {
  id: string;
  kind: ElementKind;
  enterAt: number;
  enterEnd: number;
  holdStart: number;
  holdEnd: number;
  exitAt: number;
  exitEnd: number;
};

/**
 * Resolve a choreography timeline for all elements in a scene.
 *
 * Does NOT mutate elements — returns computed timelines for analysis,
 * validation, or auto-repair.
 */
export function resolveElementTimeline(
  scene: SceneSpec,
  profile: ChoreographyProfile = DEFAULT_PROFILE,
): ElementTimeline[] {
  const elements = scene.elements;
  if (!elements || elements.length === 0) return [];

  const transOutDur = getTransitionOutDuration(scene);

  // Sort elements by kind priority (stable sort — preserves original order for same kind)
  const sorted = [...elements].sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99),
  );

  // Compute the latest any OUT can start: before transition begins
  const latestOutStart = Math.max(
    0,
    scene.duration - transOutDur - profile.elementOutLeadFrames,
  );

  const result: ElementTimeline[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const el = sorted[i];
    const enterDur =
      el.motion.enter.durationFrames ?? profile.defaultEnterDur;
    const exitDur =
      el.motion.exit?.durationFrames ?? profile.defaultExitDur;

    // ── Enter: use existing at, or auto-stagger ──
    const enterAt = el.motion.enter.at;
    const enterEnd = enterAt + enterDur;

    // ── Exit: use existing at, or compute from latestOutStart with reverse stagger ──
    const reverseIdx = sorted.length - 1 - i;
    const autoExitAt = Math.max(
      enterEnd + profile.minHoldFrames,
      latestOutStart - reverseIdx * Math.max(2, Math.floor(profile.staggerFrames * 0.6)),
    );
    const exitAt = el.motion.exit?.at ?? autoExitAt;
    const exitEnd = exitAt + exitDur;

    result.push({
      id: el.id,
      kind: el.kind,
      enterAt,
      enterEnd,
      holdStart: enterEnd,
      holdEnd: exitAt,
      exitAt,
      exitEnd,
    });
  }

  return result;
}

/**
 * Auto-stagger: compute suggested enter.at and exit.at values for an
 * element list. Returns a new array with updated motion timings.
 *
 * This is used by the spec generator to create properly choreographed elements.
 */
export function autoStaggerElements(
  elements: ElementDef[],
  sceneDuration: number,
  transitionOutDuration: number,
  profile: ChoreographyProfile = DEFAULT_PROFILE,
): ElementDef[] {
  if (elements.length === 0) return elements;

  // Sort by priority
  const sorted = [...elements].sort(
    (a, b) =>
      (KIND_PRIORITY[a.kind] ?? 99) - (KIND_PRIORITY[b.kind] ?? 99),
  );

  const latestOutStart = Math.max(
    0,
    sceneDuration - transitionOutDuration - profile.elementOutLeadFrames,
  );

  return sorted.map((el, i) => {
    const enterAt = 2 + i * profile.staggerFrames;
    const enterDur =
      el.motion.enter.durationFrames ?? profile.defaultEnterDur;

    // Reverse-stagger exit: last-to-enter exits first (highest priority exits last)
    const reverseIdx = sorted.length - 1 - i;
    const exitAt = Math.max(
      enterAt + enterDur + profile.minHoldFrames,
      latestOutStart - reverseIdx * Math.max(2, Math.floor(profile.staggerFrames * 0.6)),
    );

    return {
      ...el,
      motion: {
        enter: { ...el.motion.enter, at: enterAt },
        exit: el.motion.exit
          ? { ...el.motion.exit, at: exitAt }
          : { type: "fadeOut", durationFrames: profile.defaultExitDur, at: exitAt },
      },
    };
  });
}

/**
 * Validate that all elements finish their OUT animation before the scene
 * transition begins. Returns an array of violation descriptions (empty = OK).
 */
export function validateChoreography(
  scene: SceneSpec,
  profile: ChoreographyProfile = DEFAULT_PROFILE,
): string[] {
  const elements = scene.elements;
  if (!elements || elements.length === 0) return [];

  const transOutDur = getTransitionOutDuration(scene);
  const transStart = scene.duration - transOutDur;
  const violations: string[] = [];

  for (const el of elements) {
    if (!el.motion.exit) continue;
    const exitDur = el.motion.exit.durationFrames ?? profile.defaultExitDur;
    const exitEnd = el.motion.exit.at + exitDur;

    // Warn if exit animation extends past scene end
    if (exitEnd > scene.duration) {
      violations.push(
        `${el.id}: exit ends at frame ${exitEnd} but scene ends at ${scene.duration}`,
      );
    }

    // Warn if exit starts after transition starts (still animating during wipe)
    if (el.motion.exit.at >= transStart && transOutDur > 0) {
      violations.push(
        `${el.id}: exit starts at frame ${el.motion.exit.at} but transitionOut starts at ${transStart} (${transOutDur}f transition)`,
      );
    }
  }

  return violations;
}

// ── Helpers ──

function getTransitionOutDuration(scene: SceneSpec): number {
  if (scene.enhancedTransitionOut) return scene.enhancedTransitionOut.duration;
  if (scene.transitionOut) return scene.transitionOut.duration;
  return 0;
}

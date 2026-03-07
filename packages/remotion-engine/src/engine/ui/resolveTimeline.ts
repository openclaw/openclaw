/**
 * resolveTimeline — Pure keyframe resolver for propsTimeline.
 *
 * Given the current frame and a sorted propsTimeline[], returns the
 * merged PropsTimelineProps for that frame. No React dependency.
 *
 * Merge rules:
 * - toggles[]: merge by label (last keyframe with that label wins)
 * - checkmarks[]: accumulate (union of all labels seen up to current frame)
 * - progress, activeAspect: last keyframe value wins
 * - pressed, status: last keyframe value wins (snap, no interpolation)
 * - tap: only active for TAP_DURATION frames after its keyframe
 */
import {
  PropsTimelineEntry,
  PropsTimelineProps,
  PropsTimelineToggleState,
  PropsTimelineTap,
} from "../parser/MotionSpecTypes";

const TAP_DURATION = 10; // frames a tap ripple stays active

const DEFAULTS: PropsTimelineProps = {
  toggles: [],
  activeAspect: 0,
  pressed: false,
  progress: 0,
  status: "idle",
  tap: undefined,
  checkmarks: [],
  highlightToggleIndex: undefined,
};

/**
 * Find the frame at which the most recent tap occurred, or -Infinity.
 */
function findLastTapFrame(
  frame: number,
  timeline: PropsTimelineEntry[],
): { tap: PropsTimelineTap; at: number } | undefined {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i];
    if (entry.at > frame) continue;
    if (entry.props.tap) {
      return { tap: entry.props.tap, at: entry.at };
    }
  }
  return undefined;
}

/**
 * Merge toggle states: later entries override earlier ones (matched by label).
 */
function mergeToggles(
  accumulated: Map<string, boolean>,
  incoming: PropsTimelineToggleState[] | undefined,
): void {
  if (!incoming) return;
  for (const t of incoming) {
    accumulated.set(t.label, t.on);
  }
}

export function resolveTimeline(
  frame: number,
  timeline: PropsTimelineEntry[],
): PropsTimelineProps {
  if (!timeline || timeline.length === 0) return { ...DEFAULTS };

  // Fast path: before first keyframe
  if (frame < timeline[0].at) return { ...DEFAULTS };

  // Accumulate state from all keyframes up to current frame
  const toggleMap = new Map<string, boolean>();
  const checkmarkSet = new Set<string>();
  let activeAspect = DEFAULTS.activeAspect!;
  let pressed = DEFAULTS.pressed!;
  let progress = DEFAULTS.progress!;
  let status = DEFAULTS.status!;
  let highlightToggleIndex: number | undefined = undefined;
  let tapTarget: string | undefined = undefined;

  for (const entry of timeline) {
    if (entry.at > frame) break;

    const p = entry.props;
    mergeToggles(toggleMap, p.toggles);

    if (p.activeAspect !== undefined) activeAspect = p.activeAspect;
    if (p.pressed !== undefined) pressed = p.pressed;
    if (p.progress !== undefined) progress = p.progress;
    if (p.status !== undefined) status = p.status;
    if (p.highlightToggleIndex !== undefined) highlightToggleIndex = p.highlightToggleIndex;
    if (p.tapTarget !== undefined) tapTarget = p.tapTarget;
    if (p.checkmarks) {
      for (const label of p.checkmarks) checkmarkSet.add(label);
    }
  }

  // Convert toggle map back to array
  const toggles: PropsTimelineToggleState[] = [];
  for (const [label, on] of toggleMap) {
    toggles.push({ label, on });
  }

  // Resolve tap (only active for TAP_DURATION frames)
  const lastTap = findLastTapFrame(frame, timeline);
  const tap =
    lastTap && frame - lastTap.at < TAP_DURATION ? lastTap.tap : undefined;

  return {
    toggles,
    activeAspect,
    pressed,
    progress,
    status,
    tap,
    tapTarget,
    checkmarks: Array.from(checkmarkSet),
    highlightToggleIndex,
  };
}

/**
 * Find the frame at which a specific toggle was first turned ON.
 * Returns -1 if never turned ON.
 */
export function findToggleFlipFrame(
  label: string,
  timeline: PropsTimelineEntry[],
): number {
  for (const entry of timeline) {
    if (entry.props.toggles) {
      for (const t of entry.props.toggles) {
        if (t.label === label && t.on) return entry.at;
      }
    }
  }
  return -1;
}

/**
 * Find the frame at which the button was pressed.
 * Returns -1 if never pressed.
 */
export function findPressFrame(timeline: PropsTimelineEntry[]): number {
  for (const entry of timeline) {
    if (entry.props.pressed === true) return entry.at;
  }
  return -1;
}

/**
 * Find the frame at which a specific checkmark label first appeared.
 * Returns -1 if never shown.
 */
export function findCheckmarkFrame(
  label: string,
  timeline: PropsTimelineEntry[],
): number {
  for (const entry of timeline) {
    if (entry.props.checkmarks?.includes(label)) return entry.at;
  }
  return -1;
}

/**
 * Find the frame at which the most recent tap occurred (for ripple).
 */
export function findTapStartFrame(
  frame: number,
  timeline: PropsTimelineEntry[],
): number {
  const result = findLastTapFrame(frame, timeline);
  return result ? result.at : -1;
}

/**
 * Extract all tapTarget keyframes from a timeline (for cursor path).
 * Returns entries sorted by `at` with tapTarget + whether it's a click.
 */
export function extractTapTargetKeyframes(
  timeline: PropsTimelineEntry[],
): { at: number; tapTarget: string; click: boolean }[] {
  const results: { at: number; tapTarget: string; click: boolean }[] = [];
  for (const entry of timeline) {
    if (entry.props.tapTarget) {
      // A tapTarget with a tap or pressed=true is a click event
      const isClick = !!(entry.props.tap || entry.props.pressed);
      results.push({
        at: entry.at,
        tapTarget: entry.props.tapTarget,
        click: isClick,
      });
    }
  }
  return results;
}

export { TAP_DURATION };

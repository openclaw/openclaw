/**
 * transitionGuard — Anti-jank guard for transitions.
 *
 * When a scene has environment.type="premiere_timeline" (busy background),
 * reduce transition blur/bloom by 40% to prevent visual noise.
 *
 * Also clamps grain to prevent "gross" grain pop during scene changes.
 */
import type { EnhancedTransitionSpec, SceneSpec } from "../parser/MotionSpecTypes";

/**
 * Apply anti-jank adjustments to a transition spec based on scene context.
 * Returns a new spec (does not mutate input).
 */
export function applyTransitionGuard(
  trans: EnhancedTransitionSpec,
  scene: SceneSpec,
): EnhancedTransitionSpec {
  const hasBusyEnv =
    scene.environment?.type === "premiere_timeline" ||
    scene.environment?.type === "social_feed";

  if (!hasBusyEnv) return trans;

  // Reduce blur/bloom by 40% on busy environments
  const REDUCTION = 0.6; // keep 60% of original values

  const result: EnhancedTransitionSpec = { ...trans };

  // Reduce blur in dipFade/crossfade
  if (result.out) {
    result.out = { ...result.out };
    if (result.out.blurToPx !== undefined) {
      result.out.blurToPx = Math.round(result.out.blurToPx * REDUCTION);
    }
  }
  if (result.in) {
    result.in = { ...result.in };
    if (result.in.blurFromPx !== undefined) {
      result.in.blurFromPx = Math.round(result.in.blurFromPx * REDUCTION);
    }
  }

  // Reduce glow opacity on wipe/sweep
  if (result.edgeGlowOpacity !== undefined) {
    result.edgeGlowOpacity = result.edgeGlowOpacity * REDUCTION;
  }

  // Clamp grain to prevent pop
  if (result.antiBanding) {
    result.antiBanding = { ...result.antiBanding };
    if (result.antiBanding.grainOpacity !== undefined) {
      result.antiBanding.grainOpacity = Math.min(0.06, result.antiBanding.grainOpacity);
    }
  }

  // Reduce feather slightly to keep edge clean
  if (result.featherPx !== undefined) {
    result.featherPx = Math.round(result.featherPx * 0.8);
  }

  return result;
}

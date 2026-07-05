// Slack plugin module implements truncate behavior.
<<<<<<< HEAD
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function truncateSlackText(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
<<<<<<< HEAD
  // Slice on a code-point boundary so a surrogate pair (emoji / astral char)
  // straddling the limit is dropped whole, instead of leaving a lone surrogate
  // half that serializes to an invalid `\uD83D` in the Slack payload.
  if (max <= 1) {
    return sliceUtf16Safe(trimmed, 0, max);
  }
  return `${sliceUtf16Safe(trimmed, 0, max - 1)}…`;
=======
  if (max <= 1) {
    return trimmed.slice(0, max);
  }
  return `${trimmed.slice(0, max - 1)}…`;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

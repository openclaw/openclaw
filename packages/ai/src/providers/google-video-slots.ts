import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { VideoContent } from "../provider-types.js";

export const GOOGLE_VIDEO_SLOT_OMISSION = "(video omitted: native video slot unavailable)";
export type GoogleVideoSlots = Map<Record<string, unknown>, VideoContent>;

export function createGoogleVideoPlaceholder<T extends { text: string }>(
  video: VideoContent,
  slots: GoogleVideoSlots | undefined,
  placeholder: T,
): T {
  slots?.set(placeholder, video);
  return placeholder;
}

/** Only original slot identities may recover private bytes after mutable payload hooks. */
export function materializeGoogleVideoSlots(
  payload: unknown,
  slots: GoogleVideoSlots,
  materialize: (slot: Record<string, unknown>, video: VideoContent) => void,
  omitInjected: (part: Record<string, unknown>) => void,
): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const part = asOptionalRecord(value);
    if (!part) {
      return;
    }
    const video = slots.get(part);
    if (video) {
      Object.keys(part).forEach((key) => Reflect.deleteProperty(part, key));
      materialize(part, video);
      return;
    }
    omitInjected(part);
    Object.values(part).forEach(visit);
  };
  visit(payload);
}

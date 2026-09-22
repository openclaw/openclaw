import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ImageContent } from "../../../llm/types.js";
import { isImageMediaFact, type MediaFact } from "../../../media/media-facts.js";
import type { AgentMessage } from "../../runtime/index.js";

export type ImageFactIndex = number | null;

export type MediaImageLayout = {
  slots: Array<{ kind: "inline" | "offloaded"; factIndex?: number }>;
  suppressedFactIndexes?: number[];
};

/** Adds extracted pages to a transient projection without letting them claim photo slots. */
export function appendExtractedPromptImages(
  message: Extract<AgentMessage, { role: "user" }>,
  media: readonly MediaFact[],
  pages: Array<{ image: ImageContent; factIndex: number }>,
): Extract<AgentMessage, { role: "user" }> {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: "text" as const, text: message.content }];
  const existingImages = content.filter((block) => block.type === "image");
  const layout = readPersistedMediaImageLayout(message);
  const inlineIndexes = layout?.slots.flatMap((slot) =>
    slot.kind === "inline" ? [slot.factIndex ?? null] : [],
  );
  // Canonical history may retain photo bytes but omit the factless document
  // page slots. In that shape, only the fact-owned inline slots describe bytes.
  const ownedInlineIndexes = inlineIndexes?.filter((index) => index !== null);
  const inferredIndexes =
    inlineIndexes?.length === existingImages.length
      ? inlineIndexes
      : ownedInlineIndexes?.length === existingImages.length
        ? ownedInlineIndexes
        : undefined;
  const existingIndexes = readPersistedImageBlockFactIndexes(message) ?? inferredIndexes;
  const indexes = [
    ...existingImages.map((_, index) => existingIndexes?.[index] ?? null),
    ...pages.map((page) => page.factIndex),
  ];
  // Rebuild only the transient layout: canonical document-page slots are factless,
  // while the extracted pages now have exact attachment identities and page order.
  const slots = media.flatMap((fact, factIndex): MediaImageLayout["slots"] => {
    const owned = indexes.filter((index) => index === factIndex);
    return owned.length
      ? owned.map(() => ({ kind: "inline" as const, factIndex }))
      : isImageMediaFact(fact)
        ? [{ kind: "offloaded" as const, factIndex }]
        : [];
  });
  slots.push(...indexes.flatMap((index) => (index === null ? [{ kind: "inline" as const }] : [])));
  const meta = Reflect.get(message, "__openclaw");
  const extractedFactIndexes = new Set(pages.map((page) => page.factIndex));
  // Gateway document facts suppress direct binary hydration. These pages have
  // already passed document extraction/access policy; exempt only their transient
  // projection, never described photos or the canonical facts.
  const projectedMedia = media.map((fact, index) =>
    extractedFactIndexes.has(index) ? { ...fact, hydrationSuppressed: false } : fact,
  );
  const projectedSuppression = layout?.suppressedFactIndexes?.filter(
    (index) => !extractedFactIndexes.has(index),
  );
  const projected = {
    ...message,
    content: [...content, ...pages.map((page) => page.image)],
    __openclaw: {
      ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}),
      media: projectedMedia,
      mediaImageBlockFactIndexes: indexes,
      mediaImageLayout: {
        ...layout,
        slots,
        ...(projectedSuppression ? { suppressedFactIndexes: projectedSuppression } : {}),
      },
    },
  };
  return projected;
}

export function readPersistedImageBlockFactIndexes(
  message: AgentMessage,
): ImageFactIndex[] | undefined {
  const value = asOptionalRecord(Reflect.get(message, "__openclaw"))?.mediaImageBlockFactIndexes;
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.map((entry) => asSafeIntegerInRange(entry, { min: 0 }) ?? null);
}

export function readPersistedMediaImageLayout(message: AgentMessage): MediaImageLayout | undefined {
  const record = asOptionalRecord(
    asOptionalRecord(Reflect.get(message, "__openclaw"))?.mediaImageLayout,
  );
  if (!record) {
    return undefined;
  }
  const slots = Array.isArray(record.slots)
    ? record.slots.flatMap((entry) => {
        const slot = asOptionalRecord(entry);
        if (slot?.kind !== "inline" && slot?.kind !== "offloaded") {
          return [];
        }
        const kind: MediaImageLayout["slots"][number]["kind"] = slot.kind;
        const factIndex = asSafeIntegerInRange(slot.factIndex, { min: 0 });
        return [
          {
            kind,
            ...(factIndex !== undefined ? { factIndex } : {}),
          },
        ];
      })
    : [];
  const suppressedFactIndexes = Array.isArray(record.suppressedFactIndexes)
    ? record.suppressedFactIndexes.filter(
        (entry): entry is number => asSafeIntegerInRange(entry, { min: 0 }) !== undefined,
      )
    : [];
  return slots.length > 0 || suppressedFactIndexes.length > 0
    ? { slots, suppressedFactIndexes }
    : undefined;
}

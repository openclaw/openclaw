import type { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { FeishuNativeCard } from "./native-card.js";
// Feishu plugin module builds the presentation card the direct-send actions own.
import { presentationTableMode, presentationTextRenderer } from "./outbound.js";
import {
  buildFeishuPresentationCard,
  feishuCardWithinTableLimit,
  isFeishuCardWithinEnvelope,
} from "./presentation-card.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;

/**
 * The direct-send actions build their own card, so they own the table mode the presentation
 * fallback otherwise gets from `sendPayload`, and the same two limits decide whether the card
 * they produced can be delivered at all.
 */
export function buildFeishuActionPresentationCard(params: {
  presentation?: NormalizedMessagePresentation;
  cfg: Parameters<typeof presentationTextRenderer>[0]["cfg"];
  accountId?: string;
  fallbackText?: string;
}): FeishuNativeCard | undefined {
  if (!params.presentation) {
    return undefined;
  }
  const modeContext = { cfg: params.cfg, accountId: params.accountId };
  return buildFeishuPresentationCard({
    presentation: params.presentation,
    renderText: presentationTextRenderer(modeContext),
    tableMode: presentationTableMode(modeContext),
    ...(params.fallbackText === undefined ? {} : { fallbackText: params.fallbackText }),
  });
}

export function deliverableFeishuActionCard(
  card: FeishuNativeCard | undefined,
): FeishuNativeCard | undefined {
  return card && feishuCardWithinTableLimit(card) && isFeishuCardWithinEnvelope(card)
    ? card
    : undefined;
}

/**
 * The bounded holder for delivery evidence of message sends that have already
 * SETTLED.
 *
 * `execute-messaging-evidence.ts` bounds a send while its result is still
 * outstanding, and the run's retention decision refunds that charge the moment
 * the result arrives. What the settle path then copies out of the arguments —
 * the message text, the inline media urls, the confirmed target with its
 * content — outlives the refund, and was bounded only by
 * `CLI_MESSAGING_EVIDENCE_MAX_CALLS`. A count cap bounds nothing here for the
 * same reason it bounds nothing on the pending side: one send's content can
 * approach the whole per-turn budget on its own, so 64 sequential sends that
 * each start, settle and refund inside the pending budget still leave hundreds
 * of MiB reachable with `retainedToolArgChars` reading zero.
 *
 * So this holder carries the same two-part bound as the pending one: a count
 * cap per collection, and one aggregate character budget for the run. Past the
 * budget an entry keeps the facts and drops the bulk —
 * `reduceMessagingToolArgs` decides what is a fact by size, exactly as it does
 * for a pending send — and a dropped text or media url leaves its digest
 * behind, because "this run already sent this" is the one thing the payload
 * itself was proving.
 *
 * NOT bounded here: `messagingToolSourceReplyPayloads`. Those are not evidence
 * of a delivery, they are outbound content the host has still to deliver
 * (`run/payloads.ts` mirrors them as this turn's reply), so reducing one would
 * drop a user-visible reply rather than an echo of it. Its bound stays the
 * count cap.
 */
import { sha256Hex } from "../../infra/crypto-digest.js";
import { normalizeTextForComparison } from "../embedded-agent-helpers/messaging-dedupe.js";
import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "../embedded-agent-messaging.types.js";
import {
  MAX_SETTLED_MESSAGING_EVIDENCE_CHARS,
  measureToolArgChars,
  reduceMessagingToolArgs,
} from "./execute-event-retention.js";
import { CLI_MESSAGING_EVIDENCE_MAX_CALLS } from "./execute-messaging.js";

/** The retained cost of a send or payload object, framing included. */
function measureSend(send: MessagingToolSend): number {
  return measureToolArgChars(send as unknown as Record<string, unknown>);
}

/**
 * Keeps the one thing a dropped body was still doing for the run.
 *
 * `reply-payloads-dedupe.ts` is the consumer that decides whether a reply the
 * host is about to send was already delivered by a `message` tool call, and it
 * decides that by comparing the *exported* `text` of a settled send with the
 * payload in hand. So a body dropped for want of retention budget does not
 * only cost an echo: it costs that route's duplicate suppression, and the turn
 * can deliver the same answer twice. The digest set this module keeps for its
 * own de-duplication is private and reaches no consumer.
 *
 * A 64-character digest of the comparison form of the dropped text, carried on
 * the reduced send itself, keeps route-scoped exact-repeat suppression at a
 * fixed cost. It is deliberately only exact-repeat: the global substring rule
 * in `isMessagingToolDuplicate` cannot be evaluated against a digest, which is
 * why this is route-scoped evidence on the target rather than a replacement
 * for the text in the run's global sent-text set.
 */
function withComparisonDigest(
  reduced: MessagingToolSend,
  original: MessagingToolSend,
): MessagingToolSend {
  if (reduced.text !== undefined || original.text === undefined) {
    return reduced;
  }
  const normalized = normalizeTextForComparison(original.text);
  if (!normalized) {
    return reduced;
  }
  return { ...reduced, textComparisonDigest: sha256Hex(normalized) };
}

export function createSettledMessagingEvidence() {
  /** Retained value -> the characters it charged, so eviction can refund. */
  const texts = new Map<string, number>();
  const mediaUrls = new Map<string, number>();
  const textDigests = new Set<string>();
  const mediaUrlDigests = new Set<string>();
  const targets = new Map<string, MessagingToolSend>();
  const sourceReplyPayloads: MessagingToolSourceReplyPayload[] = [];
  let retainedChars = 0;
  let reducedEntries = 0;
  let droppedChars = 0;

  /** Charges the full payload, or records that it did not fit. */
  const charge = (chars: number): boolean => {
    if (retainedChars + chars > MAX_SETTLED_MESSAGING_EVIDENCE_CHARS) {
      reducedEntries += 1;
      droppedChars += chars;
      return false;
    }
    retainedChars += chars;
    return true;
  };
  /**
   * A reduced entry is admitted unconditionally: it is capped per entry by
   * `MAX_REDUCED_MESSAGING_ARG_CHARS` and in count by the collection's own cap,
   * so its worst case is additive rather than a multiple of the turn budget.
   */
  const chargeReduced = (chars: number): void => {
    retainedChars += chars;
  };
  const admitDigest = (digests: Set<string>, digest: string): void => {
    if (digests.has(digest)) {
      return;
    }
    if (digests.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
      const oldest = digests.keys().next();
      if (!oldest.done) {
        digests.delete(oldest.value);
      }
    }
    digests.add(digest);
  };
  const appendUnique = (
    values: Map<string, number>,
    digests: Set<string>,
    additions: readonly string[],
  ): void => {
    for (const addition of additions) {
      const digest = sha256Hex(addition);
      if (!addition || values.has(addition) || digests.has(digest)) {
        continue;
      }
      if (values.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
        const oldest = values.keys().next();
        if (!oldest.done) {
          retainedChars -= values.get(oldest.value) ?? 0;
          values.delete(oldest.value);
        }
      }
      if (!charge(addition.length)) {
        // The value is gone; the fact that this run already sent it is not.
        admitDigest(digests, digest);
        continue;
      }
      values.set(addition, addition.length);
    }
  };

  return {
    appendTexts: (additions: readonly string[]): void =>
      appendUnique(texts, textDigests, additions),
    appendMediaUrls: (additions: readonly string[]): void =>
      appendUnique(mediaUrls, mediaUrlDigests, additions),
    hasTarget: (evidenceKey: string): boolean => targets.has(evidenceKey),
    /**
     * Admits a confirmed send under its content digest. The key is derived from
     * the full send, so a repeat of an already-settled send is recognized here
     * whether or not its content survived; what a reduced entry must carry for
     * the *delivery* consumer is `textComparisonDigest` (see
     * `withComparisonDigest`), because that consumer compares exported text and
     * never sees these keys.
     */
    admitTarget(evidenceKey: string, target: MessagingToolSend): void {
      if (targets.has(evidenceKey)) {
        return;
      }
      if (targets.size >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
        const oldest = targets.keys().next();
        const evicted = oldest.done ? undefined : targets.get(oldest.value);
        if (!oldest.done) {
          retainedChars -= evicted ? measureSend(evicted) : 0;
          targets.delete(oldest.value);
        }
      }
      if (charge(measureSend(target))) {
        targets.set(evidenceKey, target);
        return;
      }
      const reduction = reduceMessagingToolArgs(target as unknown as Record<string, unknown>);
      const reduced = withComparisonDigest(reduction.args as MessagingToolSend, target);
      chargeReduced(measureSend(reduced));
      targets.set(evidenceKey, reduced);
    },
    /**
     * Admits a source-reply mirror payload. Count-bounded only: see the module
     * comment — this list is the turn's outbound content, not an echo of it.
     */
    pushSourceReplyPayload(
      payload: MessagingToolSourceReplyPayload,
      sourceReplyFinal?: boolean,
    ): void {
      if (sourceReplyPayloads.length >= CLI_MESSAGING_EVIDENCE_MAX_CALLS) {
        sourceReplyPayloads.shift();
      }
      // Each internal source-reply send is a distinct delivery, even when two
      // intentional sends have identical text or media.
      sourceReplyPayloads.push({
        ...payload,
        ...(sourceReplyFinal !== undefined ? { sourceReplyFinal } : {}),
      });
    },
    sourceReplyPayloads: (): MessagingToolSourceReplyPayload[] => [...sourceReplyPayloads],
    texts: (): string[] => [...texts.keys()],
    mediaUrls: (): string[] => [...mediaUrls.keys()],
    targets: (): MessagingToolSend[] => [...targets.values()],
    sizes: () => ({
      settledMessagingEvidenceChars: retainedChars,
      reducedSettledMessagingEntries: reducedEntries,
      droppedSettledMessagingChars: droppedChars,
    }),
  };
}

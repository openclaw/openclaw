import { publishTranscriptUpdate } from "../../config/sessions/session-accessor.js";
import { settlePreparedAssistantTranscriptMetadataAtAnchor } from "../../config/sessions/session-message-rewrite.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { StopReason, Usage } from "../../llm/types.js";
import type { PluginTextReplacement } from "../../plugins/cli-backend.types.js";
import type { CliCommentarySegment, CliOutput } from "../cli-output-contracts.js";
import { projectAgentHarnessTranscriptMessageForDisplay } from "../harness/transcript-visibility.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { buildUsageWithNoCost } from "../stream-message-shared.js";
import {
  persistCliAssistantTranscript,
  buildCliAssistantTranscriptUsage,
  cliAssistantProgressMetadata,
  resolveCliAssistantStopReason,
} from "./cli-run-transcript.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";
export type CliPersistedSegment = {
  text: string;
  key?: string;
  anchor: TranscriptEntryAnchor;
  settled?: true;
};

export async function persistCliAssistantSettlement(params: {
  runParams: RunCliAgentParams;
  segments: CliPersistedSegment[];
  nativeFinal?: { text: string; identity: { cliSessionId: string; externalId: string } };
  output: CliOutput;
  modelId: string;
  textReplacements?: PluginTextReplacement[];
  sourceReplyWasDelivered: boolean;
  /** Priced turn usage from `buildCliAssistantTranscriptUsage`; computed here when omitted. */
  usage?: Usage;
}) {
  const { runParams, segments, nativeFinal, output, modelId, sourceReplyWasDelivered } = params;
  const usage =
    params.usage ??
    (
      await buildCliAssistantTranscriptUsage({
        runParams,
        modelId,
        usage: output.usage,
        turnUsage: output.diagnosticUsage,
      })
    ).usage;
  const finalKey = nativeFinal
    ? `${nativeFinal.identity.cliSessionId}:${nativeFinal.identity.externalId}`
    : undefined;
  // Without a native final row, stdout may aggregate snapshots on success as well as interruption.
  let remainingText = output.text;
  if (!nativeFinal) {
    remainingText = cliUnpersistedAssistantTail(output, segments, params.textReplacements);
  }
  // A tail row persisted below carries the turn usage; segments then carry none.
  const tailCarriesUsage = Boolean(remainingText && !finalKey && !sourceReplyWasDelivered);
  const settled = await settleCliAssistantSegments({
    runParams,
    segments,
    finalKey,
    output: tailCarriesUsage ? { ...output, usage: undefined, diagnosticUsage: undefined } : output,
    ...(tailCarriesUsage ? {} : { usage }),
    sourceReplyWasDelivered,
  });
  const finalAlreadyPersisted = finalKey && segments.some((row) => row.key === finalKey);
  return finalAlreadyPersisted || ((!remainingText || sourceReplyWasDelivered) && segments.length)
    ? { owned: true, ...settled }
    : await persistCliAssistantTranscript({
        runParams,
        // Dispatch owns visible source-reply mirrors and their idempotency keys.
        text: sourceReplyWasDelivered ? "" : (nativeFinal?.text ?? remainingText),
        ...(nativeFinal
          ? {
              nativeIdentity: nativeFinal.identity,
              segmentKey: `${nativeFinal.identity.cliSessionId}:${nativeFinal.identity.externalId}`,
            }
          : {}),
        modelId,
        usage,
        stopReason: resolveCliAssistantStopReason(output),
        yielded: output.yielded,
      });
}

/** Remove only parser-identified output spans whose snapshot was durably committed. */
export function cliUnpersistedAssistantTail(
  output: CliOutput,
  segments: ReadonlyArray<{ key?: string }>,
  replacements?: PluginTextReplacement[],
): string {
  const text = output.rawText ?? output.text;
  const persisted = new Set(segments.map((segment) => segment.key));
  let end = 0;
  let tail = "";
  for (const range of output.textSnapshotRanges ?? []) {
    if (persisted.has(range.key)) {
      tail += text.slice(end, range.start);
      end = range.end;
    }
  }
  // Transform the remaining raw text once; replacements may span a snapshot boundary.
  return end
    ? applyPluginTextReplacements((tail + text.slice(end)).trim(), replacements)
    : output.text;
}

/** Amend only rows durably committed by this attempt, under its current writer fence. */
export async function settleCliAssistantSegments(params: {
  runParams: RunCliAgentParams;
  segments: CliPersistedSegment[];
  finalKey?: string;
  output: CliOutput;
  stopReason?: StopReason;
  sourceReplyWasDelivered: boolean;
  /** Priced terminal usage; absent means the turn reported none. */
  usage?: Usage;
}): Promise<{ terminalAnchor?: TranscriptEntryAnchor; idempotencyKey?: string }> {
  const terminal = params.finalKey
    ? params.segments.find((segment) => segment.key === params.finalKey)
    : params.segments.at(-1);
  const stopReason = params.stopReason ?? resolveCliAssistantStopReason(params.output);
  for (const segment of params.segments) {
    const isTerminal = segment === terminal;
    const assertOwned = captureOwnedTranscriptWriteAssertion(segment.anchor);
    const updated = await settlePreparedAssistantTranscriptMetadataAtAnchor(
      segment.anchor,
      (value) => {
        if (Reflect.get(value, "idempotencyKey") !== segment.anchor.idempotencyKey) {
          return undefined;
        }
        return projectAgentHarnessTranscriptMessageForDisplay({
          runId: params.runParams.runId,
          hidden: params.runParams.privateCompletion === true,
          inputProvenance: params.runParams.inputProvenance,
          message: {
            ...value,
            ...(params.sourceReplyWasDelivered ? { display: false } : {}),
            stopReason,
            ...cliAssistantProgressMetadata({
              yielded: params.output.yielded,
              stopReason,
              runId: params.runParams.runId,
              text: value.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(""),
            }),
            ...(isTerminal
              ? {
                  usage: params.usage ?? buildUsageWithNoCost({}),
                }
              : {}),
          },
        });
      },
      {
        assertCurrent: () => {
          assertOwned();
          params.runParams.assertCurrent?.();
        },
        // An absent expectation is not an expectation of an unversioned entry.
        // The captured transcript owner assertion above still fences every rewrite.
        expectedEntry:
          params.runParams.expectedLifecycleRevision !== undefined || params.runParams.sessionEntry
            ? {
                lifecycleRevision:
                  params.runParams.expectedLifecycleRevision ??
                  params.runParams.sessionEntry?.lifecycleRevision ??
                  null,
                activeWriterRunId: params.runParams.expectedWriterRunId,
              }
            : undefined,
      },
    );
    if (!updated) {
      throw new Error("CLI segment settlement lost its transcript anchor");
    }
    segment.anchor = updated.anchor;
    segment.settled = true;
  }
  return terminal
    ? { terminalAnchor: terminal.anchor, idempotencyKey: terminal.anchor.idempotencyKey }
    : {};
}

/**
 * Persist and track completed snapshots through the same serialized runner queue.
 * A completed snapshot is visible at once, in its transcript slot: the live stream is one
 * cumulative tail that cannot interleave with tools or accepted steers. Settlement (or
 * stranding) still rewrites its stop reason from the run outcome.
 */
export async function persistCliAssistantSegment(
  runParams: RunCliAgentParams,
  modelId: string,
  segments: CliPersistedSegment[],
  segment: CliCommentarySegment,
  sequence: number,
) {
  const key = segment.key ?? `unkeyed:${sequence}`;
  const persisted = await persistCliAssistantTranscript({
    runParams,
    text: segment.text,
    modelId,
    stopReason: "stop",
    segmentKey: key,
    timestamp: segment.timestamp,
    ...(segment.native
      ? {
          nativeIdentity: {
            cliSessionId: segment.native.sessionId,
            externalId: segment.native.entryId,
          },
        }
      : {}),
  });
  if (
    persisted.idempotencyKey &&
    persisted.terminalAnchor &&
    !segments.some((row) => row.anchor.entryId === persisted.terminalAnchor?.entryId)
  ) {
    segments.push({ ...segment, key, anchor: persisted.terminalAnchor });
  }
}

/** Serializes completed snapshots and lets each attempt drain before settlement or recovery. */
export function createCliAssistantSegmentQueue(
  context: PreparedCliRunContext,
  warn: (message: string) => void,
) {
  const onError = (error: unknown) =>
    warn(`CLI segment persistence failed: ${formatErrorMessage(error)}`);
  const persistedSegments: CliPersistedSegment[] = [];
  let segmentWrites = Promise.resolve();
  let segmentSequence = 0;
  const persistSegment = (segment: CliCommentarySegment) => {
    segmentWrites = segmentWrites
      .then(async () => {
        context.cliHistoryWriter?.checkNativeLoginBoundary(false);
        await context.cliHistoryWriter?.settleNativeLogin();
        await persistCliAssistantSegment(
          context.params,
          context.modelId,
          persistedSegments,
          segment,
          segmentSequence++,
        );
      })
      .catch(onError);
  };
  // An attempt that ends without settlement (retry, failure, lost writer) strands its snapshots.
  const strand = async () => {
    await segmentWrites;
    const stranded = persistedSegments.filter((segment) => !segment.settled);
    persistedSegments.length = 0;
    await settleCliAssistantSegments({
      runParams: context.params,
      segments: stranded,
      output: { text: "" },
      stopReason: "aborted",
      sourceReplyWasDelivered: false,
    }).catch(onError);
    // Revealed rows were never published as visible; clients resync before the failure lands.
    if (stranded[0]) {
      await publishTranscriptUpdate(stranded[0].anchor).catch(onError);
    }
  };
  return {
    segments: persistedSegments,
    push: persistSegment,
    drain: () => segmentWrites,
    strand,
  };
}

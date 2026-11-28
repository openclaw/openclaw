import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CliJsonlStreamingParserOptions, CliUsage } from "./cli-output-contracts.js";
import {
  isClaudeStreamJsonDialect,
  isClaudeSubagentRecord,
  readCliUsage,
  supportsCliJsonlToolEvents,
} from "./cli-output-records.js";
import { deriveSessionTotalTokens } from "./usage.js";

/** Keep context on the parent model call; a terminal result may bill many calls. */
export function createCliUsageObserver(params: CliJsonlStreamingParserOptions) {
  const claudeStreamJson = isClaudeStreamJsonDialect(params);
  let parentStreamId: string | undefined;
  let refinedParentId: string | undefined;
  let measuredParentId: string | undefined;
  return (
    parsed: Record<string, unknown>,
    previousUsage: CliUsage | undefined,
    previousDiagnosticUsage: CliUsage | undefined,
  ) => {
    let usage = previousUsage;
    const nextUsage = readCliUsage(parsed);
    const isClaudeTerminalResult = claudeStreamJson && parsed.type === "result";
    const diagnosticUsage =
      isClaudeTerminalResult && nextUsage && usage ? nextUsage : previousDiagnosticUsage;
    if (nextUsage) {
      params.onUsage?.(nextUsage, isClaudeTerminalResult);
    }
    if (claudeStreamJson && !isClaudeSubagentRecord(parsed)) {
      const evt =
        parsed.type === "stream_event" && isRecord(parsed.event) ? parsed.event : undefined;
      const message =
        parsed.type === "assistant"
          ? parsed.message
          : evt?.type === "message_start"
            ? evt.message
            : undefined;
      const id = isRecord(message) && typeof message.id === "string" ? message.id : undefined;
      if (evt?.type === "message_start") {
        parentStreamId = id;
        refinedParentId = undefined;
      }
      const delta = evt?.type === "message_delta" && parentStreamId !== undefined;
      // Claude deltas refine the current call; null counters mean unchanged, not zero.
      const previous = delta && parentStreamId === measuredParentId ? usage : undefined;
      const patch = delta && isRecord(evt.usage) ? evt.usage : undefined;
      const measured = patch
        ? readCliUsage({
            usage: {
              input_tokens: patch.input_tokens ?? previous?.input,
              output_tokens: patch.output_tokens ?? previous?.output,
              cache_read_input_tokens: patch.cache_read_input_tokens ?? previous?.cacheRead,
              cache_creation_input_tokens:
                patch.cache_creation_input_tokens ?? previous?.cacheWrite,
              cache_creation:
                patch.cache_creation ??
                (patch.cache_creation_input_tokens == null ||
                patch.cache_creation_input_tokens === previous?.cacheWrite
                  ? { ephemeral_1h_input_tokens: previous?.cacheWrite1h }
                  : undefined),
            },
          })
        : isRecord(message) && message.model !== "<synthetic>" && (!id || id !== refinedParentId)
          ? readCliUsage({ usage: message.usage })
          : undefined;
      const tokens = deriveSessionTotalTokens({ lastCallUsage: measured });
      if (measured && tokens !== undefined) {
        usage = measured;
        measuredParentId = delta ? parentStreamId : id;
        if (delta) {
          refinedParentId = parentStreamId;
        }
        params.onContextTokens?.(tokens);
      } else if (isClaudeTerminalResult && !usage && parsed.openclaw_interim_result !== true) {
        usage = nextUsage;
      }
      if (evt?.type === "message_stop") {
        parentStreamId = undefined;
      }
    } else if (
      !claudeStreamJson &&
      (!supportsCliJsonlToolEvents(params) || parsed.type !== "result" || !usage)
    ) {
      usage = nextUsage ?? usage;
    }
    return { usage, diagnosticUsage };
  };
}

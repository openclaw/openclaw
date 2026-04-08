import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  applyAutocompact,
  DEFAULT_AUTOCOMPACT_CONFIG,
  type AutocompactRuntime,
} from "../../improvements/autocompact.js";
import { applyMicrocompact, DEFAULT_MICROCOMPACT_CONFIG } from "../../improvements/microcompact.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { summarizeWithFallback } from "../compaction.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";

const log = createSubsystemLogger("improvements-integration");

type SessionBeforeCompactPreparation = {
  messagesToSummarize: AgentMessage[];
  turnPrefixMessages: AgentMessage[];
};

type SessionBeforeCompactEvent = {
  preparation: SessionBeforeCompactPreparation;
};

type ModelAuthResult = {
  ok: boolean;
  apiKey?: string;
  headers?: Record<string, string>;
  error?: string;
};

type ImprovementsContext = ExtensionContext & {
  modelRegistry?: {
    getApiKeyAndHeaders?: (
      model: NonNullable<ExtensionContext["model"]>,
    ) => Promise<ModelAuthResult>;
  };
};

async function buildAutocompactRuntime(
  ctx: ImprovementsContext,
): Promise<AutocompactRuntime | null> {
  const model = ctx.model;
  const getApiKeyAndHeaders = ctx.modelRegistry?.getApiKeyAndHeaders;
  if (!model || !getApiKeyAndHeaders) {
    return null;
  }

  const auth = await getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    log.warn(`Autocompact auth unavailable: ${auth.error ?? "missing api key"}`);
    return null;
  }

  const apiKey = auth.apiKey;
  return {
    model,
    summarize: async (messages: AgentMessage[]) =>
      summarizeWithFallback({
        messages,
        model,
        apiKey,
        headers: auth.headers,
        signal: new AbortController().signal,
        reserveTokens: 4096,
        maxChunkTokens: Math.max(4096, (model.contextWindow ?? DEFAULT_CONTEXT_TOKENS) / 2),
        contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
      }),
  };
}

async function compactMessageList(
  messages: AgentMessage[],
  ctx: ImprovementsContext,
): Promise<AgentMessage[]> {
  if (messages.length === 0) {
    return messages;
  }

  let nextMessages = messages;
  nextMessages = await applyMicrocompact(nextMessages, DEFAULT_MICROCOMPACT_CONFIG);

  const runtime = await buildAutocompactRuntime(ctx);
  if (!runtime) {
    return nextMessages;
  }

  return applyAutocompact(nextMessages, runtime, {
    ...DEFAULT_AUTOCOMPACT_CONFIG,
    contextWindowTokens: ctx.model?.contextWindow ?? DEFAULT_CONTEXT_TOKENS,
  });
}

export default function improvementsIntegrationExtension(api: ExtensionAPI): void {
  api.on(
    "session_before_compact",
    async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
      const typedCtx = ctx as ImprovementsContext;
      event.preparation.messagesToSummarize = await compactMessageList(
        event.preparation.messagesToSummarize,
        typedCtx,
      );
      event.preparation.turnPrefixMessages = await compactMessageList(
        event.preparation.turnPrefixMessages,
        typedCtx,
      );
      log.info(
        `[Improvements] compacted preparation to summarize=${event.preparation.messagesToSummarize.length} ` +
          `turnPrefix=${event.preparation.turnPrefixMessages.length}`,
      );
      return undefined;
    },
  );
}

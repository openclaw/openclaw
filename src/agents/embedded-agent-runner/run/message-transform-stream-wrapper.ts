import {
  PROVIDER_CONTEXT_HANDOFF,
  type ProviderContext,
  type ProviderStreamOptions,
} from "@openclaw/ai/provider-types";
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { AgentMessage } from "../../runtime/index.js";

type MessageTransform = (
  messages: AgentMessage[],
  model: Parameters<StreamFn>[0],
) => AgentMessage[];
type ProviderContextMaterializer = (input: {
  context: Parameters<StreamFn>[1];
  signal?: AbortSignal;
}) => Promise<ProviderContext>;

export function wrapStreamFnWithMessageTransform(
  streamFn: StreamFn,
  transform: MessageTransform,
  materializeProviderContext?: ProviderContextMaterializer,
): StreamFn {
  return (model, context, options) => {
    const messages = context.messages;
    const nextMessages = transform(messages, model);
    const nextContext =
      nextMessages !== messages
        ? {
            ...context,
            messages: nextMessages as typeof context.messages,
          }
        : context;
    if (!materializeProviderContext) {
      return streamFn(model, nextContext, options);
    }
    let providerContext: Promise<ProviderContext> | undefined;
    const handoff = async (): Promise<ProviderContext> => {
      options?.signal?.throwIfAborted();
      return (providerContext ??= materializeProviderContext({
        context: nextContext,
        signal: options?.signal,
      }));
    };
    return streamFn(model, nextContext, {
      ...options,
      [PROVIDER_CONTEXT_HANDOFF]: handoff,
    } as ProviderStreamOptions & NonNullable<Parameters<StreamFn>[2]>);
  };
}

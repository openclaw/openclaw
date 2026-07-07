// Discord plugin module implements outbound components behavior.
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  createLazyRuntimeModule,
  createLazyRuntimeNamedExport,
} from "openclaw/plugin-sdk/lazy-runtime";
import { readDiscordComponentSpec, type DiscordComponentMessageSpec } from "./components.js";

type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;
type OutboundPayload = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];

const loadDiscordComponentSend = createLazyRuntimeNamedExport(
  () => import("./send.components.js"),
  "sendDiscordComponentMessage",
);

export async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  return await (
    await loadDiscordComponentSend()
  )(...args);
}

const loadDiscordSharedInteractive = createLazyRuntimeModule(
  () => import("./shared-interactive.js"),
);

function addPayloadTextFallback(
  spec: DiscordComponentMessageSpec,
  payload: Pick<OutboundPayload, "text">,
): DiscordComponentMessageSpec {
  return spec.text
    ? spec
    : {
        ...spec,
        text: payload.text?.trim() ? payload.text : undefined,
      };
}

export async function buildDiscordPresentationPayload(params: {
  payload: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0]["payload"];
  presentation: Parameters<
    NonNullable<ChannelOutboundAdapter["renderPresentation"]>
  >[0]["presentation"];
}): Promise<typeof params.payload | null> {
  const componentSpec = (await loadDiscordSharedInteractive()).buildDiscordPresentationComponents(
    params.presentation,
  );
  if (!componentSpec) {
    return null;
  }
  return {
    ...params.payload,
    channelData: {
      ...params.payload.channelData,
      discord: {
        ...(params.payload.channelData?.discord as Record<string, unknown> | undefined),
        presentationComponents: componentSpec,
      },
    },
  };
}

export async function resolveDiscordComponentSpec(
  payload: OutboundPayload,
): Promise<DiscordComponentMessageSpec | undefined> {
  const discordData = payload.channelData?.discord as
    | { components?: unknown; presentationComponents?: DiscordComponentMessageSpec }
    | undefined;
  const rawComponentSpec =
    discordData?.presentationComponents ??
    (discordData?.components &&
    typeof discordData.components === "object" &&
    !Array.isArray(discordData.components)
      ? readDiscordComponentSpec(discordData.components)
      : null);
  if (rawComponentSpec) {
    return addPayloadTextFallback(rawComponentSpec, payload);
  }
  if (!payload.interactive) {
    return undefined;
  }
  const interactiveSpec = (await loadDiscordSharedInteractive()).buildDiscordInteractiveComponents(
    payload.interactive,
  );
  return interactiveSpec ? addPayloadTextFallback(interactiveSpec, payload) : undefined;
}

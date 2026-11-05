import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

export const slackMediaLog = createSubsystemLogger("gateway/channels/slack").child("media");
export { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
export type { FetchLike } from "openclaw/plugin-sdk/media-runtime";
export { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
export { saveRemoteMedia, unlinkIfExists } from "openclaw/plugin-sdk/media-runtime";

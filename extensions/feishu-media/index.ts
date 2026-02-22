/**
 * @openclaw/feishu-media
 *
 * Audio speech-to-text (Feishu native + Whisper) and media payload utilities
 * for feishu channel messages.
 */
export {
  recognizeAudioWithFeishuStt,
  getFeishuTenantAccessToken,
  resolveFeishuApiBase,
} from "./src/feishu-stt.js";

export {
  recognizeAudioWithWhisper,
} from "./src/whisper-stt.js";

export {
  buildFeishuMediaPayload,
  type FeishuMediaInfoExt,
  type FeishuMediaPayload,
} from "./src/media-payload.js";

export {
  createMediaDebugLogger,
  type MediaDebugLogger,
} from "./src/media-debug.js";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

export default function register(api: OpenClawPluginApi) {
  api.lifecycle.onHealthCheck(async () => ({ ok: true }));
}

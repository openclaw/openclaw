/**
 * Re-exports from the canonical core module so that all imports resolve to the
 * same singleton `listeners` Map at runtime, regardless of which tsdown build
 * output they land in.
 *
 * See: https://github.com/openclaw/openclaw/issues/48409
 */
export {
  type ActiveWebListener,
  type ActiveWebSendOptions,
  getActiveWebListener,
  requireActiveWebListener,
  resolveWebAccountId,
  setActiveWebListener,
} from "../../../src/channels/whatsapp-active-listener.js";

/**
 * Public API barrel for the Kudosity SMS extension.
 *
 * Core and other extensions should import from this barrel rather than
 * reaching into `./src/*` internals directly (see extensions/AGENTS.md).
 */

export { kudositySmsPlugin } from "./src/channel.js";
export type { KudositySmsAccount } from "./src/channel.js";
export { setKudositySmsRuntime, getKudositySmsRuntime } from "./src/runtime.js";
export {
  handleWebhookRequest,
  parseWebhookPayload,
  type KudosityWebhookPayload,
  type InboundMessage,
} from "./src/webhook.js";

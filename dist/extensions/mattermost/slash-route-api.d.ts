import { C as OpenClawPluginApi } from "../../types-Vx7Jq4_-2.js";
import { IncomingMessage, ServerResponse } from "node:http";

//#region extensions/mattermost/src/mattermost/slash-state.d.ts
/**
 * Register the HTTP route for slash command callbacks.
 * Called during plugin registration.
 *
 * The single HTTP route dispatches to the correct per-account handler by
 * matching the inbound token against each account's known tokens, falling back
 * to registered team/trigger ownership so upstream validation can accept a
 * rotated Mattermost token.
 */
declare function registerSlashCommandRoute(api: OpenClawPluginApi): void;
//#endregion
export { registerSlashCommandRoute };
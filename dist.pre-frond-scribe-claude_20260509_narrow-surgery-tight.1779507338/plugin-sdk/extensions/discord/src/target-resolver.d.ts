import type { DirectoryConfigParams } from "openclaw/plugin-sdk/directory-runtime";
import { type MessagingTarget } from "openclaw/plugin-sdk/messaging-targets";
import { type DiscordTargetParseOptions } from "./target-parsing.js";
/**
 * Resolve a Discord username to user ID using the directory lookup.
 * This enables sending DMs by username instead of requiring explicit user IDs.
 */
export declare function resolveDiscordTarget(raw: string, options: DirectoryConfigParams, parseOptions?: DiscordTargetParseOptions): Promise<MessagingTarget | undefined>;
export declare function parseAndResolveDiscordTarget(raw: string, options: DirectoryConfigParams, parseOptions?: DiscordTargetParseOptions): Promise<MessagingTarget>;

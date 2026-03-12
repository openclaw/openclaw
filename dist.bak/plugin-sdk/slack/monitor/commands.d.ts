import type { SlackSlashCommandConfig } from "../../config/config.js";
/**
 * Strip Slack mentions (<@U123>, <@U123|name>) so command detection works on
 * normalized text. Use in both prepare and debounce gate for consistency.
 */
export declare function stripSlackMentionsForCommandDetection(text: string): string;
export declare function normalizeSlackSlashCommandName(raw: string): string;
export declare function resolveSlackSlashCommandConfig(raw?: SlackSlashCommandConfig): Required<SlackSlashCommandConfig>;
export declare function buildSlackSlashCommandMatcher(name: string): RegExp;

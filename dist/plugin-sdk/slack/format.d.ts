import type { MarkdownTableMode } from "../config/types.base.js";
type SlackMarkdownOptions = {
    tableMode?: MarkdownTableMode;
};
export declare function markdownToSlackMrkdwn(markdown: string, options?: SlackMarkdownOptions): string;
export declare const SLACK_INCIDENT_LABELS: readonly ["Incident", "Customer impact", "Affected services", "Status", "Evidence", "Likely cause", "Mitigation", "Validate", "Next", "Also watching", "Auto-fix PR", "Linear", "Suggested PR", "Fix PR", "Context", "What the PR does"];
export declare function containsSlackIncidentLabel(text: string): boolean;
export declare function enforceIncidentLabelFormat(text: string): string;
export declare function normalizeSlackOutboundText(markdown: string): string;
export declare function markdownToSlackMrkdwnChunks(markdown: string, limit: number, options?: SlackMarkdownOptions): string[];
export {};

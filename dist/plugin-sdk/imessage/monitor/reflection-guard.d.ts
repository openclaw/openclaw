/**
 * Detects inbound messages that are reflections of assistant-originated content.
 * These patterns indicate internal metadata leaked into a channel and then
 * bounced back as a new inbound message — creating an echo loop.
 */
export type ReflectionDetection = {
    isReflection: boolean;
    matchedLabels: string[];
};
/**
 * Check whether an inbound message appears to be a reflection of
 * assistant-originated content. Returns matched pattern labels for telemetry.
 */
export declare function detectReflectedContent(text: string): ReflectionDetection;

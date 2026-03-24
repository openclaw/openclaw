/**
 * Configuration for Slack image optimization.
 * Allows users to opt-out of automatic JPEG degradation for PNG resources.
 * Addresses #53932.
 */
export interface SlackImageConfig {
    optimizeUploads: boolean; // Default: true
}

export const defaultSlackImageConfig: SlackImageConfig = {
    optimizeUploads: true
};

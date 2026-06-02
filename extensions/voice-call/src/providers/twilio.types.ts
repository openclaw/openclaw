import type { WebhookSecurityConfig } from "../config.js";

/** Runtime options for Twilio webhook verification, media stream URLs, and dev-only bypasses. */
export interface TwilioProviderOptions {
  /** Allows unsigned loopback callbacks produced by ngrok's free interstitial flow. */
  allowNgrokFreeTierLoopbackBypass?: boolean;
  /** Canonical external origin used when Twilio signs a URL different from the local request. */
  publicUrl?: string;
  /** WebSocket path advertised in generated TwiML stream responses. */
  streamPath?: string;
  /** Development-only escape hatch; production should verify every Twilio callback. */
  skipVerification?: boolean;
  /** Forwarded-header trust and host allowlist controls for signature URL reconstruction. */
  webhookSecurity?: WebhookSecurityConfig;
}

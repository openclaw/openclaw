import type { OpenClawConfig } from "../config/types.openclaw.js";
/**
 * Detect heartbeat configs that pin a non-existent session. The runtime
 * resolves `heartbeat.session` to a sessionKey via `resolveHeartbeatSession`;
 * if the entry is missing, `resolveHeartbeatDeliveryTarget` falls back to
 * `{channel:"none", reason:"no-target"}` and the heartbeat fires a model
 * call whose reply has nowhere to land. Common cause: the configured Slack
 * channel ID does not match any channel the agent has ever joined (e.g.,
 * heartbeat pins channel `c0b2eddpw95` but the agent only has sessions in
 * `c0ag7jag35g`, or the agent has no Slack bot at all).
 *
 * Warning only — repair would mean rewriting the config, which is the
 * operator's intent to express.
 */
export declare function describeHeartbeatSessionTargetIssues(cfg: OpenClawConfig): string[];

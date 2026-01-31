import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { getDingTalkRuntime } from "./runtime.js";
import { resolveDingTalkCredentials } from "./token.js";

export type MonitorDingTalkOpts = {
  cfg: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
};

export type MonitorDingTalkResult = {
  shutdown: () => Promise<void>;
};

/**
 * Monitor DingTalk provider using Stream Mode (WebSocket).
 *
 * This connects to DingTalk's stream API using the official dingtalk-stream SDK.
 * Stream mode doesn't require a public URL/webhook - it uses WebSocket connections.
 */
export async function monitorDingTalkProvider(
  opts: MonitorDingTalkOpts,
): Promise<MonitorDingTalkResult> {
  const core = getDingTalkRuntime();
  const log = core.logging.getChildLogger({ name: "dingtalk" });
  let cfg = opts.cfg;
  let dingtalkCfg = cfg.channels?.dingtalk;
  if (!dingtalkCfg?.enabled) {
    log.debug("dingtalk provider disabled");
    return { shutdown: async () => {} };
  }

  const creds = resolveDingTalkCredentials(dingtalkCfg);
  if (!creds) {
    log.error("dingtalk credentials not configured");
    return { shutdown: async () => {} };
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  // TODO: Implement actual DingTalk Stream SDK integration
  // This is a placeholder implementation
  // The actual implementation should:
  // 1. Import and initialize the dingtalk-stream SDK
  // 2. Set up WebSocket connection handlers
  // 3. Handle incoming messages and route them to the channel system
  // 4. Handle group allowlist/policy checking with @mention requirements
  // 5. Implement DM pairing flow for user authorization

  log.info("DingTalk monitor started (stream mode)");
  log.warn("DingTalk monitor implementation is incomplete - stream SDK integration needed");

  return {
    shutdown: async () => {
      log.info("DingTalk monitor stopped");
    },
  };
}

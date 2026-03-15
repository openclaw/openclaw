import { logger } from "./logger.js";
import { streamManager } from "./stream-manager.js";
import { wecomChannelPlugin } from "./wecom/channel-plugin.js";
import { wecomHttpHandler } from "./wecom/http-handler.js";
import { wecomUploadHttpHandler } from "./wecom/upload-route.js";
import { responseUrls, setOpenclawConfig, setRuntime, streamMeta } from "./wecom/state.js";

// Periodic cleanup for streamMeta and expired responseUrls to prevent memory leaks.
setInterval(() => {
  const now = Date.now();
  // Clean streamMeta entries whose stream no longer exists in streamManager.
  for (const streamId of streamMeta.keys()) {
    if (!streamManager.hasStream(streamId)) {
      streamMeta.delete(streamId);
    }
  }
  // Clean expired responseUrls (older than 1 hour).
  for (const [key, entry] of responseUrls.entries()) {
    if (now > entry.expiresAt) {
      responseUrls.delete(key);
    }
  }
}, 60 * 1000).unref();

const plugin = {
  // Plugin id should match `openclaw.plugin.json` id (and config.plugins.entries key).
  id: "wecom",
  name: "Enterprise WeChat",
  description: "Enterprise WeChat AI Bot channel plugin for OpenClaw",
  configSchema: { type: "object", additionalProperties: false, properties: {} },
  register(api) {
    logger.info("WeCom plugin registering...");

    // Save runtime for message processing
    setRuntime(api.runtime);
    setOpenclawConfig(api.config);

    // Register channel
    api.registerChannel({ plugin: wecomChannelPlugin });
    logger.info("WeCom channel registered");

    // Register HTTP routes for webhooks (bot + agent inbound)
    api.registerHttpRoute({
      path: "/webhooks/wecom",
      handler: wecomHttpHandler,
      auth: "plugin",
      match: "prefix",
    });
    logger.info("WeCom HTTP route registered: /webhooks/wecom");

    api.registerHttpRoute({
      path: "/webhooks/app",
      handler: wecomHttpHandler,
      auth: "plugin",
      match: "prefix",
    });
    logger.info("WeCom HTTP route registered: /webhooks/app");

    api.registerHttpRoute({
      path: "/wecom/upload",
      handler: wecomUploadHttpHandler,
      auth: "plugin",
      match: "prefix",
    });
    logger.info("WeCom HTTP route registered: /wecom/upload");
  },
};

export default plugin;
export const register = (api) => plugin.register(api);

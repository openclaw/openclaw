import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { closePool } from "./src/db-client.js";
import { resolveConfig } from "./src/http-client.js";
import { ApiKeyResolver } from "./src/key-resolver.js";
import {
  createLegalCheckCreateToolFactory,
  createLegalCheckStatusToolFactory,
} from "./src/legal-check-tools.js";

export default definePluginEntry({
  id: "legal-check",
  name: "Legal Check",
  description:
    "Create 图文/视频违规·不实信息检测 jobs and query their status by calling the leading-v2.0 PHP API " +
    "as the chat user (Authorization: Bearer <per-uid apiKey>). Tools are scoped to rabbitmq-<userId> " +
    "agents; per-uid keys are resolved (and auto-provisioned) from the api_key table.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});
    // One shared resolver: explicit override -> existing api_key row -> auto-mint.
    const resolver = new ApiKeyResolver(config.apiKeys, config.db);

    api.registerTool(createLegalCheckCreateToolFactory(api, resolver), {
      name: "legal_check_create",
    });
    api.registerTool(createLegalCheckStatusToolFactory(api, resolver), {
      name: "legal_check_status",
    });

    api.registerService({
      id: "legal-check",
      start(ctx) {
        ctx.logger.info("[LEGAL_CHECK] Service initialized");
      },
      async stop(ctx) {
        await closePool();
        ctx.logger.info("[LEGAL_CHECK] DB pool closed, service stopped");
      },
    });
  },
});

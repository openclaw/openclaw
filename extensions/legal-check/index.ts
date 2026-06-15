import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import {
  createLegalCheckCreateToolFactory,
  createLegalCheckStatusToolFactory,
} from "./src/legal-check-tools.js";

export default definePluginEntry({
  id: "legal-check",
  name: "Legal Check",
  description:
    "Create 图文/视频违规·不实信息检测 jobs and query their status by calling the leading-v2.0 PHP API " +
    "as the chat user (X-Auth-Token = userId). Tools are scoped to rabbitmq-<userId> chat agents; the " +
    "backend enforces auth, credit, and dispatch.",
  register(api: OpenClawPluginApi) {
    api.registerTool(createLegalCheckCreateToolFactory(api), { name: "legal_check_create" });
    api.registerTool(createLegalCheckStatusToolFactory(api), { name: "legal_check_status" });

    api.registerService({
      id: "legal-check",
      start(ctx) {
        ctx.logger.info("[LEGAL_CHECK] Service initialized");
      },
    });
  },
});

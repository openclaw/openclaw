import { definePluginEntry, type OpenClawPluginApi } from "./api.js";
import { createInfringementCreateToolFactory } from "./src/infringement-create-tool.js";
import { createInfringementQueryToolFactory } from "./src/infringement-query-tool.js";
import { closePools, resolveConfig } from "./src/mysql-client.js";
import { TaskWorkerPublisher } from "./src/rabbitmq-publisher.js";

export default definePluginEntry({
  id: "infringement",
  name: "Infringement",
  description:
    "Query 图文/视频侵权检测 cases and create 研判 tasks against the leading-v2.0 backend, " +
    "with entity_auth(Legal) access control. Both tools are scoped to rabbitmq-<userId> chat agents.",
  register(api: OpenClawPluginApi) {
    const config = resolveConfig(api.pluginConfig ?? {});
    // One shared publisher holds the broker connection for task dispatch.
    const publisher = new TaskWorkerPublisher(config.rabbitmq, api.logger);

    // Read tool: list/inspect cases, profile accounts, KPI. Hidden from agents
    // without a Legal grant; secret cases and PII are gated/masked server-side.
    api.registerTool(createInfringementQueryToolFactory(api), { name: "infringement_query" });

    // Write tool: create a 研判 task (case + links) and dispatch to the Java
    // TaskWorker queue. Same Legal gate; case.uid = the trusted agent userId.
    api.registerTool(createInfringementCreateToolFactory(api, publisher), {
      name: "infringement_create_task",
    });

    api.registerService({
      id: "infringement",
      start(ctx) {
        ctx.logger.info("[INFRINGEMENT] Service initialized");
      },
      async stop(ctx) {
        await publisher.close();
        await closePools();
        ctx.logger.info("[INFRINGEMENT] Publisher and MySQL pools closed, service stopped");
      },
    });
  },
});

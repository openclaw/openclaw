import { createServer } from "node:http";
import { loadJitsiBridgeConfig } from "../src/jitsi-bridge/config.js";
import { createJitsiBridgeApp } from "../src/jitsi-bridge/service.js";

const config = loadJitsiBridgeConfig();
const app = createJitsiBridgeApp(config);
const server = createServer(app);

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      ok: true,
      host: config.host,
      port: config.port,
      stateDir: config.stateDir,
      jitsiBaseUrl: config.jitsiBaseUrl,
      realtimeModel: config.realtimeModel,
    }),
  );
});

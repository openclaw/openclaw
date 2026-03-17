import { afterEach } from "vitest";
import { createNextcloudTalkWebhookServer } from "./monitor.js";
const cleanupFns = [];
afterEach(async () => {
  while (cleanupFns.length > 0) {
    const cleanup = cleanupFns.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});
async function startWebhookServer(params) {
  const host = params.host ?? "127.0.0.1";
  const port = params.port ?? 0;
  const secret = params.secret ?? "nextcloud-secret";
  const { server, start } = createNextcloudTalkWebhookServer({
    ...params,
    port,
    host,
    secret
  });
  await start();
  const address = server.address();
  if (!address) {
    throw new Error("missing server address");
  }
  const harness = {
    webhookUrl: `http://${host}:${address.port}${params.path}`,
    stop: () => new Promise((resolve) => {
      server.close(() => resolve());
    })
  };
  cleanupFns.push(harness.stop);
  return harness;
}
export {
  startWebhookServer
};

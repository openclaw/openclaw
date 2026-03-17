import { createMatrixClient } from "./client/create-client.js";
import { startMatrixClientWithGrace } from "./client/startup.js";
import { getMatrixLogService } from "./sdk-runtime.js";
async function createPreparedMatrixClient(opts) {
  const client = await createMatrixClient({
    homeserver: opts.auth.homeserver,
    userId: opts.auth.userId,
    accessToken: opts.auth.accessToken,
    encryption: opts.auth.encryption,
    localTimeoutMs: opts.timeoutMs,
    accountId: opts.accountId
  });
  if (opts.auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await client.crypto.prepare(joinedRooms);
    } catch {
    }
  }
  await startMatrixClientWithGrace({
    client,
    onError: (err) => {
      const LogService = getMatrixLogService();
      LogService.error("MatrixClientBootstrap", "client.start() error:", err);
    }
  });
  return client;
}
export {
  createPreparedMatrixClient
};

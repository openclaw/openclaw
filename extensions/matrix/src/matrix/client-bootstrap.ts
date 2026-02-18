import { createMatrixClient } from "./client.js";

type MatrixClientBootstrapAuth = {
  homeserver: string;
  userId: string;
  accessToken: string;
  encryption?: boolean;
};

type MatrixCryptoPrepare = {
  prepare: (rooms?: string[]) => Promise<void>;
};

type MatrixBootstrapClient = Awaited<ReturnType<typeof createMatrixClient>>;

export async function createPreparedMatrixClient(opts: {
  auth: MatrixClientBootstrapAuth;
  timeoutMs?: number;
  accountId?: string;
}): Promise<MatrixBootstrapClient> {
  const client = await createMatrixClient({
    homeserver: opts.auth.homeserver,
    userId: opts.auth.userId,
    accessToken: opts.auth.accessToken,
    encryption: opts.auth.encryption,
    localTimeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
  });
  if (opts.auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await (client.crypto as MatrixCryptoPrepare).prepare(joinedRooms);
    } catch {
      // Ignore crypto prep failures for one-off requests.
    }
  }
  await client.start();
  return client;
}

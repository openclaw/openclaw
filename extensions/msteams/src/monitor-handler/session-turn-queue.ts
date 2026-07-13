// Msteams plugin module serializes session turn handling.

const msteamsSessionTurnChains = new Map<string, Promise<void>>();

function resolveMSTeamsTurnChainKey(params: { storePath?: string; sessionKey: string }): string {
  const sessionKey = params.sessionKey.trim();
  const storePath = params.storePath?.trim();
  if (storePath) {
    return sessionKey ? `store:${storePath}:session:${sessionKey}` : `store:${storePath}`;
  }
  return sessionKey ? "global" : "";
}

export async function enqueueMSTeamsSessionTurn<T>(
  params: {
    storePath?: string;
    sessionKey: string;
  },
  task: () => Promise<T>,
): Promise<T> {
  const key = resolveMSTeamsTurnChainKey(params);
  if (!key) {
    return await task();
  }
  const previous = msteamsSessionTurnChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  msteamsSessionTurnChains.set(key, settled);
  const cleanup = () => {
    if (msteamsSessionTurnChains.get(key) === settled) {
      msteamsSessionTurnChains.delete(key);
    }
  };
  settled.then(cleanup, cleanup);
  return await current;
}

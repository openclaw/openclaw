// Delivery checks run at drained workload checkpoints, independently of timing windows.
export function createTeamStressFanoutReceipts(clientCount: number, injectionKeys: string[]) {
  const foregroundKeys = new Set<string>();
  const requiredEventKeys = new Set<string>();
  const injectionSessions = new Set(injectionKeys);
  const sessionReceipts = new Map<string, Map<string, number[]>>();
  const injected = new Map<string, number[]>();
  const expectedInjections = new Set<string>();
  const foregroundEvents = new Set<string>();
  let observingSessions = false;
  const messageKey = (sessionKey: string, messageId: string) =>
    JSON.stringify([sessionKey, messageId]);
  function record(receipts: Map<string, number[]>, key: string, client: number) {
    let counts = receipts.get(key);
    if (!counts) {
      counts = Array<number>(clientCount).fill(0);
      receipts.set(key, counts);
    }
    counts[client]!++;
  }
  return {
    trackForeground(keys: string[], requireEvents = true) {
      // Start after all clients subscribe; setup can publish before that boundary.
      observingSessions = true;
      for (const key of keys) {
        foregroundKeys.add(key);
        if (requireEvents) {
          requiredEventKeys.add(key);
        }
      }
    },
    observe(client: number, event: string, payload: Record<string, unknown> | undefined) {
      if (
        (event !== "session.message" && event !== "sessions.changed") ||
        typeof payload?.sessionKey !== "string"
      ) {
        return;
      }
      const sessionKey = payload.sessionKey;
      if (observingSessions) {
        // Native child publications can precede the spawn response naming the session.
        let receipts = sessionReceipts.get(sessionKey);
        if (!receipts) {
          receipts = new Map();
          sessionReceipts.set(sessionKey, receipts);
        }
        foregroundEvents.add(JSON.stringify([sessionKey, event]));
        // These publisher-owned fields survive recipient-specific row/body projection.
        record(
          receipts,
          JSON.stringify([
            sessionKey,
            event,
            payload.messageId,
            payload.reason,
            payload.phase,
            payload.ts,
          ]),
          client,
        );
      }
      if (
        event === "session.message" &&
        injectionSessions.has(sessionKey) &&
        typeof payload.messageId === "string"
      ) {
        record(injected, messageKey(sessionKey, payload.messageId), client);
      }
    },
    expectInjection(sessionKey: string, messageId: string) {
      // Publication can arrive before chat.inject returns its committed message ID.
      expectedInjections.add(messageKey(sessionKey, messageId));
    },
    pendingInjections() {
      return [...expectedInjections].filter((identity) => {
        const counts = injected.get(identity);
        return !counts || counts.some((count) => count === 0);
      });
    },
    assertComplete() {
      for (const key of requiredEventKeys) {
        for (const event of ["session.message", "sessions.changed"]) {
          if (!foregroundEvents.has(JSON.stringify([key, event]))) {
            throw new Error(`missing foreground ${event}: ${key}`);
          }
        }
      }
      for (const key of foregroundKeys) {
        for (const [identity, counts] of sessionReceipts.get(key) ?? []) {
          if (!counts[0] || counts.some((count) => count !== counts[0])) {
            throw new Error(`incomplete foreground fanout ${identity}: ${JSON.stringify(counts)}`);
          }
        }
      }
      for (const identity of expectedInjections) {
        const counts = injected.get(identity);
        if (!counts || counts.some((count) => count !== 1)) {
          throw new Error(`incomplete chat.inject fanout ${identity}: ${JSON.stringify(counts)}`);
        }
      }
      foregroundKeys.clear();
      requiredEventKeys.clear();
      sessionReceipts.clear();
      foregroundEvents.clear();
      injected.clear();
      expectedInjections.clear();
    },
  };
}

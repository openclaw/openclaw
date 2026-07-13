/** Serializes browser access with exclusive session cleanup. */

type BrowserSessionGate = {
  activeAccesses: number;
  cleanupActive: boolean;
  ownerClaimSequence: number;
  latestOwnerClaim?: { ownerId: string; sequence: number };
  accessWaiters: Array<(release: () => void) => void>;
  cleanupWaiters: Array<(release: () => void) => void>;
};

const browserSessionGates = new Map<string, BrowserSessionGate>();

function releaseBrowserSessionAccess(
  sessionKey: string,
  gate: BrowserSessionGate,
  hasTrackedTabs: (sessionKey: string) => boolean,
): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    gate.activeAccesses = Math.max(0, gate.activeAccesses - 1);
    pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
  };
}

function releaseBrowserSessionCleanup(
  sessionKey: string,
  gate: BrowserSessionGate,
  hasTrackedTabs: (sessionKey: string) => boolean,
): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    gate.cleanupActive = false;
    pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
  };
}

function pumpBrowserSessionGate(
  sessionKey: string,
  gate: BrowserSessionGate,
  hasTrackedTabs: (sessionKey: string) => boolean,
): void {
  if (gate.cleanupActive || gate.activeAccesses > 0) {
    return;
  }
  const cleanupWaiter = gate.cleanupWaiters.shift();
  if (cleanupWaiter) {
    gate.cleanupActive = true;
    cleanupWaiter(releaseBrowserSessionCleanup(sessionKey, gate, hasTrackedTabs));
    return;
  }
  while (gate.accessWaiters.length > 0) {
    gate.activeAccesses += 1;
    gate.accessWaiters.shift()?.(releaseBrowserSessionAccess(sessionKey, gate, hasTrackedTabs));
  }
  if (
    gate.activeAccesses === 0 &&
    !gate.cleanupActive &&
    gate.accessWaiters.length === 0 &&
    gate.cleanupWaiters.length === 0 &&
    (!gate.latestOwnerClaim || !hasTrackedTabs(sessionKey))
  ) {
    browserSessionGates.delete(sessionKey);
  }
}

function getBrowserSessionGate(sessionKey: string): BrowserSessionGate {
  const existing = browserSessionGates.get(sessionKey);
  if (existing) {
    return existing;
  }
  const gate: BrowserSessionGate = {
    activeAccesses: 0,
    cleanupActive: false,
    ownerClaimSequence: 0,
    accessWaiters: [],
    cleanupWaiters: [],
  };
  browserSessionGates.set(sessionKey, gate);
  return gate;
}

export function claimBrowserSessionOwner(sessionKey: string, ownerId: string): number {
  const gate = getBrowserSessionGate(sessionKey);
  const sequence = ++gate.ownerClaimSequence;
  gate.latestOwnerClaim = { ownerId, sequence };
  return sequence;
}

export function isCurrentBrowserSessionOwnerClaim(params: {
  sessionKey: string;
  ownerId?: string;
  ownerClaim?: number;
}): boolean {
  if (params.ownerId === undefined || params.ownerClaim === undefined) {
    return true;
  }
  const latest = browserSessionGates.get(params.sessionKey)?.latestOwnerClaim;
  return (
    latest === undefined ||
    (latest.ownerId === params.ownerId && latest.sequence === params.ownerClaim)
  );
}

export function acquireBrowserSessionAccess(
  sessionKey: string,
  hasTrackedTabs: (sessionKey: string) => boolean,
): Promise<() => void> {
  const gate = getBrowserSessionGate(sessionKey);
  if (!gate.cleanupActive && gate.cleanupWaiters.length === 0) {
    gate.activeAccesses += 1;
    return Promise.resolve(releaseBrowserSessionAccess(sessionKey, gate, hasTrackedTabs));
  }
  return new Promise((resolve) => {
    gate.accessWaiters.push(resolve);
  });
}

export async function acquireBrowserSessionCleanup(
  sessionKeys: string[],
  hasTrackedTabs: (sessionKey: string) => boolean,
): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const sessionKey of [...new Set(sessionKeys)].toSorted()) {
    const gate = getBrowserSessionGate(sessionKey);
    releases.push(
      await new Promise<() => void>((resolve) => {
        gate.cleanupWaiters.push(resolve);
        pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
      }),
    );
  }
  return () => {
    for (const release of releases.toReversed()) {
      release();
    }
  };
}

export function resetBrowserSessionGatesForTests(): void {
  browserSessionGates.clear();
}

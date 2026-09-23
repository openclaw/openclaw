/** Serialized container admission, access custody, and physical retirement. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { execContainer, type SandboxContainerEngine } from "./container-engine.js";

const log = createSubsystemLogger("docker");
const sandboxContainerLifecycleQueue = new KeyedAsyncQueue();

export type ContainerSourceLease = {
  authority: AdmittedRunOperatorAuthority;
  signal: AbortSignal;
  source: object;
  grant: NonNullable<AdmittedRunOperatorAuthority["gatewayAccessGrant"]>;
  release: () => void;
  adopted: boolean;
};

type PrivateContainer = {
  id: string;
  profileId: string;
  grant: ContainerSourceLease["grant"];
  sources: Map<object, { lease: ContainerSourceLease; unsubscribe: () => void }>;
  revoked: boolean;
};

// Live custody is established only at allocation. Registry rows and scope names
// cannot prove exclusive access, including after a Gateway restart.
const privateContainers = new Map<string, PrivateContainer>();

function containerAuthorityKey(engine: SandboxContainerEngine, name: string): string {
  return JSON.stringify([engine.command, ...(engine.globalArgs ?? []), name]);
}

function releasePrivateContainer(key: string): void {
  const container = privateContainers.get(key);
  if (container) {
    privateContainers.delete(key);
    for (const { lease, unsubscribe } of container.sources.values()) {
      unsubscribe();
      lease.release();
    }
    container.sources.clear();
  }
}

function retainContainerSource(
  authority: AdmittedRunOperatorAuthority | undefined,
): ContainerSourceLease | undefined {
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
  }
  if (
    !authority?.gatewayAccessGrant ||
    !authority.source ||
    !authority.signal ||
    !authority.retain
  ) {
    return undefined;
  }
  return {
    authority,
    source: authority.source,
    signal: authority.signal,
    grant: authority.gatewayAccessGrant,
    release: authority.retain(),
    adopted: false,
  };
}

async function stopRevokedPrivateContainer(
  engine: SandboxContainerEngine,
  key: string,
  container: PrivateContainer,
): Promise<void> {
  if (privateContainers.get(key) !== container || !container.revoked) {
    return;
  }
  const signal = AbortSignal.timeout(30_000);
  const killed = await execContainer(engine, ["kill", container.id], {
    allowFailure: true,
    signal,
  });
  if (killed.code === 0) {
    await execContainer(engine, ["wait", container.id], { signal });
  }
  // Do not use containerState here: an unreachable engine is not an absent or
  // stopped generation. Keep custody and surface an unverified stop as failure.
  const inspected = await execContainer(
    engine,
    ["inspect", "-f", "{{json .State}}", container.id],
    { allowFailure: true, signal },
  );
  const absent =
    inspected.code !== 0 &&
    inspected.stderr.includes(container.id) &&
    /no such (?:container|object)|container .* does not exist|no container with name or id .* found/iu.test(
      inspected.stderr,
    );
  const state: unknown = inspected.code === 0 ? JSON.parse(inspected.stdout) : undefined;
  const stopped =
    isRecord(state) && state.Running === false && state.Paused === false && state.Pid === 0;
  if (!absent && !stopped) {
    throw new Error(
      `Could not verify revoked sandbox ${container.id} stopped: ${inspected.stderr.trim() || killed.stderr.trim() || inspected.stdout.trim()}`,
    );
  }
  releasePrivateContainer(key);
  log.info(
    `Stopped private ${engine.displayName} sandbox ${container.id} after access revocation.`,
  );
}

function retainPrivateContainerSource(params: {
  engine: SandboxContainerEngine;
  name: string;
  container: PrivateContainer;
  owner: ContainerSourceLease;
}): void {
  const { container, owner } = params;
  if (container.sources.has(owner.source)) {
    return;
  }
  const key = containerAuthorityKey(params.engine, params.name);
  const onAbort = () => {
    const retained = container.sources.get(owner.source);
    if (retained?.lease !== owner) {
      return;
    }
    container.sources.delete(owner.source);
    retained.unsubscribe();
    owner.release();
    // Losing one device/source cannot stop another valid source using the same
    // invitation. Grant revocation reaches every retained original source.
    if (container.sources.size > 0) {
      return;
    }
    container.revoked = true;
    void sandboxContainerLifecycleQueue
      .enqueue(params.name, () => stopRevokedPrivateContainer(params.engine, key, container))
      .catch((error: unknown) =>
        log.error(`Private sandbox revocation cleanup failed: ${String(error)}`),
      );
  };
  owner.adopted = true;
  container.sources.set(owner.source, {
    lease: owner,
    unsubscribe: () => owner.signal.removeEventListener("abort", onAbort),
  });
  owner.signal.addEventListener("abort", onAbort, { once: true });
  if (owner.signal.aborted) {
    onAbort();
  }
}

export function bindSandboxContainerSource(params: {
  engine: SandboxContainerEngine;
  name: string;
  id: string;
  owner: ContainerSourceLease;
}): void {
  if (!/^[a-f0-9]{64}$/u.test(params.id)) {
    throw new Error("Container creation did not return an immutable container ID.");
  }
  const key = containerAuthorityKey(params.engine, params.name);
  releasePrivateContainer(key);
  const container: PrivateContainer = {
    id: params.id,
    profileId: params.owner.authority.profileId,
    grant: params.owner.grant,
    sources: new Map(),
    revoked: false,
  };
  privateContainers.set(key, container);
  retainPrivateContainerSource({ ...params, container });
}

export async function withSandboxContainerLifecycle<T>(
  name: string,
  authority: AdmittedRunOperatorAuthority | undefined,
  operation: (source: ContainerSourceLease | undefined) => Promise<T>,
): Promise<T> {
  const source = retainContainerSource(authority);
  try {
    return await sandboxContainerLifecycleQueue.enqueue(name, () => operation(source));
  } finally {
    if (source && !source.adopted) {
      source.release();
    }
  }
}

/** Called under the lifecycle lock after the incoming admission is revalidated. */
export async function admitSandboxContainerSource(params: {
  engine: SandboxContainerEngine;
  name: string;
  id: string;
  source: ContainerSourceLease | undefined;
}): Promise<boolean> {
  const key = containerAuthorityKey(params.engine, params.name);
  const container = privateContainers.get(key);
  if (!container) {
    return false;
  }
  if (container.id !== params.id) {
    releasePrivateContainer(key);
    return false;
  }
  if (container.revoked) {
    // A request queued before revocation must settle the old lifetime before
    // reusing its name. Awaiting a later queued callback here would deadlock.
    await stopRevokedPrivateContainer(params.engine, key, container);
    return true;
  } else if (
    !params.source ||
    params.source.authority.profileId !== container.profileId ||
    params.source.grant.pluginId !== container.grant.pluginId ||
    params.source.grant.grantId !== container.grant.grantId
  ) {
    // Mixed grants, staff, and unknown history permanently disqualify this
    // generation, even after their foreground work ends.
    releasePrivateContainer(key);
  } else {
    retainPrivateContainerSource({ ...params, container, owner: params.source });
  }
  return false;
}

export function releaseSandboxContainerSource(
  engine: SandboxContainerEngine,
  name: string,
  id: string,
): void {
  const key = containerAuthorityKey(engine, name);
  if (privateContainers.get(key)?.id === id) {
    releasePrivateContainer(key);
  }
}

/** Removal shares allocation's queue and releases retained source custody only after success. */
export async function removeSandboxContainerRuntime(
  engine: SandboxContainerEngine,
  name: string,
  generation?: { id: string | null; assertCurrent: () => void },
): Promise<void> {
  await sandboxContainerLifecycleQueue.enqueue(name, async () => {
    generation?.assertCurrent();
    const key = containerAuthorityKey(engine, name);
    const retained = privateContainers.get(key);
    const target = generation ? generation.id : name;
    if (target === null) {
      if (retained) {
        const inspected = await execContainer(engine, ["inspect", "-f", "{{.Id}}", retained.id], {
          allowFailure: true,
        });
        generation?.assertCurrent();
        if (
          inspected.code === 0 ||
          !/no such (?:container|object)|does not exist/iu.test(inspected.stderr)
        ) {
          throw new Error("Sandbox generation absence is unconfirmed; custody retained");
        }
        releasePrivateContainer(key);
      }
      return;
    }
    const result = await execContainer(engine, ["rm", "-f", target], { allowFailure: true });
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      if (!/No such (container|object)|does not exist/iu.test(detail)) {
        throw new Error(
          `Failed to remove ${engine.displayName} sandbox runtime ${name}: ${detail}`,
        );
      }
    }
    if (!generation || retained?.id === target) {
      releasePrivateContainer(key);
    }
    generation?.assertCurrent();
  });
}

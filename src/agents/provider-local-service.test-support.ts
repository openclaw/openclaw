import type { ChildProcess } from "node:child_process";
import { on, once } from "node:events";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { probeTestPort } from "../test-utils/ports.js";
import { stopManagedProviderLocalServices } from "./provider-local-service.js";

const ONE_SHOT_HOST_READY_TIMEOUT_MS = 30_000;
const ONE_SHOT_HOST_EXIT_TIMEOUT_MS = 5_000;
export const ONE_SHOT_HOST_READY_KIND = "ready-for-exit";
type HostExit = { code: number | null; signal: NodeJS.Signals | null };

export async function waitForReadyOneShotHostExit(
  child: ChildProcess,
  readStderr: () => string,
): Promise<HostExit> {
  const readinessSignal = AbortSignal.timeout(ONE_SHOT_HOST_READY_TIMEOUT_MS);
  let ready = false;
  try {
    for await (const args of on(child, "message", { signal: readinessSignal, close: ["exit"] })) {
      const message: unknown = args[0];
      if (
        message &&
        typeof message === "object" &&
        (message as { kind?: unknown }).kind === ONE_SHOT_HOST_READY_KIND
      ) {
        ready = true;
        break;
      }
    }
  } catch (error) {
    if (readinessSignal.aborted) {
      throw new Error(`one-shot host did not become ready${readStderr()}`, { cause: error });
    }
    throw error;
  }
  if (!ready) {
    throw new Error(
      `one-shot host exited before readiness (code=${String(child.exitCode)} signal=${String(child.signalCode)})${readStderr()}`,
    );
  }

  const exitPromise = (async (): Promise<HostExit> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { code: child.exitCode, signal: child.signalCode };
    }
    try {
      const [code, signal] = (await once(child, "exit", {
        signal: AbortSignal.timeout(ONE_SHOT_HOST_EXIT_TIMEOUT_MS),
      })) as [number | null, NodeJS.Signals | null];
      return { code, signal };
    } catch (error) {
      throw new Error(`one-shot host did not exit after readiness${readStderr()}`, {
        cause: error,
      });
    }
  })();
  // The fixture-owned IPC channel gates the exit deadline. Once removed,
  // only the managed service's diagnostic pipes can keep this host alive.
  child.disconnect();
  return await exitPromise;
}

export function createProviderLocalServiceTestFixture() {
  const claims = new Map<TestPortClaim, number[]>();

  return {
    async claimPort(offsets: number[] = [0]): Promise<number> {
      const claim = await acquireTestPortBlock({ offsets });
      claims.set(
        claim,
        offsets.map((offset) => claim.port + offset),
      );
      return claim.port;
    },
    async cleanup(this: void): Promise<void> {
      // Keep claims through shutdown; failed cleanup must not lend a live port to another file.
      await stopManagedProviderLocalServices();
      for (const ports of claims.values()) {
        for (const port of ports) {
          const probe = await probeTestPort(port);
          if (!probe.free) {
            throw new Error(`Local provider test port ${port} is still bound after cleanup`, {
              cause: probe.error,
            });
          }
        }
      }
      for (const claim of claims.keys()) {
        await claim.release();
        claims.delete(claim);
      }
    },
  };
}

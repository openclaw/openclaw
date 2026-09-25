import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  interruptCodexTurnAndWaitBestEffort,
  retireUnsafeCodexTurnClientBestEffort,
  terminateCodexBackgroundTerminals,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";

type SideThreadCleanup = {
  threadId?: string;
  turnId?: string;
  interrupt: boolean;
  terminateBackgroundTerminals: boolean;
  timeoutMs: number;
};

export async function cleanupCodexSideQuestion(
  client: CodexAppServerClient,
  params: SideThreadCleanup & {
    failure?: { error: unknown };
    afterThreadCleanup: ReadonlyArray<() => void | Promise<void>>;
  },
): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of [
    () => cleanupCodexSideThread(client, params),
    ...params.afterThreadCleanup,
  ]) {
    try {
      // Keep projector retirement and its fallback activation in the same turn.
      const pending = cleanup();
      if (pending) {
        await pending;
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 0) {
    return;
  }
  if (params.failure) {
    errors.unshift(params.failure.error);
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  // /btw displays only message; native cleanup uncertainty must remain visible there.
  throw new AggregateError(errors, errors.map(formatErrorMessage).join("; "), {
    cause: errors[0],
  });
}

async function cleanupCodexSideThread(
  client: CodexAppServerClient,
  params: SideThreadCleanup,
): Promise<void> {
  if (!params.threadId) {
    return;
  }
  if (params.interrupt && params.turnId !== undefined) {
    const confirmed = await interruptCodexTurnAndWaitBestEffort(client, {
      threadId: params.threadId,
      turnId: params.turnId,
      timeoutMs: params.timeoutMs,
    });
    if (!confirmed) {
      await retireUnsafeCodexTurnClientBestEffort(client, "side turn interrupt");
      // An unconfirmed native turn must never lose its only visible subscription.
      throw new Error(
        "Codex /btw cleanup could not confirm the side turn stopped; background terminals may still be running.",
      );
    }
  }
  if (params.terminateBackgroundTerminals && params.turnId !== undefined) {
    try {
      await terminateCodexBackgroundTerminals(client, params.threadId);
    } catch (error) {
      await retireUnsafeCodexTurnClientBestEffort(client, "side background terminals");
      throw error;
    }
  }
  if (
    !(await unsubscribeCodexThreadBestEffort(client, {
      threadId: params.threadId,
      timeoutMs: params.timeoutMs,
    }))
  ) {
    await retireUnsafeCodexTurnClientBestEffort(client, "side thread unsubscribe");
  }
}

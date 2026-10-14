import path from "node:path";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config-contracts.js";

type RemoteConfig = NonNullable<CodexAppServerRuntimeOptions["nativeHookRelay"]>;

// Only file projection is serialized here. Core remains the authority for relay
// registration, token validity, events, and lifetime.
const projections = new KeyedAsyncQueue();
const projectionOwners = new Map<string, symbol>();

/** Native ephemeral threads keep their command config across foreground runs. */
export function codexNativeHookRemoteCredentialPath(
  config: RemoteConfig,
  relayId: string,
  generation: string,
): string {
  return path.posix.join(
    config.credentialDirectory,
    `${encodeURIComponent(relayId)}.${encodeURIComponent(generation)}.json`,
  );
}

/** The deployment owns the private directory; the live relay owns this projection. */
export function createCodexNativeHookRemoteCredential(params: {
  config: RemoteConfig;
  client: Pick<CodexAppServerClient, "request">;
  relay: { relayId: string; generation: string; enableRemoteCallback(): { token: string } };
  timeoutMs: number;
  signal?: AbortSignal;
  assertCurrent: () => void;
  assertCurrentAsync?: () => Promise<void>;
}) {
  const credentialPath = codexNativeHookRemoteCredentialPath(
    params.config,
    params.relay.relayId,
    params.relay.generation,
  );
  const owner = Symbol("native-hook-credential");
  let preparation: Promise<void> | undefined;
  let removal: Promise<void> | undefined;
  let disposed = false;
  return {
    path: credentialPath,
    prepare(): Promise<void> {
      if (disposed) {
        return Promise.reject(new Error("Native hook relay credential is closed"));
      }
      preparation ??= projections.enqueue(credentialPath, async () => {
        if (disposed) {
          throw new Error("Native hook relay credential is closed");
        }
        params.assertCurrent();
        const { token } = params.relay.enableRemoteCallback();
        projectionOwners.set(credentialPath, owner);
        const credential = {
          url: `${params.config.url.replace(/\/$/, "")}/${encodeURIComponent(params.relay.relayId)}`,
          token,
        };
        try {
          await params.client.request(
            "fs/writeFile",
            {
              path: credentialPath,
              dataBase64: Buffer.from(JSON.stringify(credential)).toString("base64"),
            },
            {
              timeoutMs: params.timeoutMs,
              signal: params.signal,
              assertCurrent: params.assertCurrent,
              withCurrent: async (write) => {
                await params.assertCurrentAsync?.();
                params.assertCurrent();
                write();
              },
            },
          );
        } catch {
          // Remote errors may echo request parameters. Never surface the capability.
          throw new Error("Could not deliver the native hook relay credential to Codex");
        }
        params.assertCurrent();
        if (disposed) {
          throw new Error("Native hook relay credential closed during delivery");
        }
      });
      return preparation;
    },
    dispose(): Promise<void> {
      disposed = true;
      if (!preparation) {
        return Promise.resolve();
      }
      // A previous owner's late disposal must not remove its successor's file.
      // The shared queue orders each client write request before removal/replacement.
      removal ??= projections.enqueue(credentialPath, async () => {
        if (projectionOwners.get(credentialPath) !== owner) {
          return;
        }
        try {
          await params.client.request(
            "fs/remove",
            { path: credentialPath, force: true, recursive: false },
            { timeoutMs: params.timeoutMs },
          );
        } catch {
          throw new Error("Could not remove the retired native hook relay credential from Codex");
        } finally {
          projectionOwners.delete(credentialPath);
        }
      });
      return removal;
    },
  };
}

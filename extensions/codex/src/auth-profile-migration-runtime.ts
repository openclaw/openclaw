import { createPreparedNativeSessionBindingAuthority } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { listAgentIds, resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { withAuthProfileStoreAtEffect } from "openclaw/plugin-sdk/provider-auth-runtime";
import { captureSessionEntryCurrentCheckAsync } from "openclaw/plugin-sdk/session-binding-runtime";
import { z } from "zod";
import { resolveCodexAppServerAuthProfileId } from "./app-server/auth-profile.js";
import { readCodexPluginConfig, resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { requestCodexAppServerJson } from "./app-server/request.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";

const paramsSchema = z
  .object({
    agentId: z.string().trim().min(1),
    sessionKey: z.string().trim().min(1),
    expectedSessionId: z.string().trim().min(1),
    expectedThreadId: z.string().trim().min(1),
    expectedClientId: z.string().trim().min(1).nullable(),
    expectedAuthProfileId: z.string().trim().min(1),
    expectedAccountEmail: z.string().trim().email(),
    expectedServerUrl: z.string().url(),
    apply: z.boolean().default(false),
    confirmNativeAccount: z.boolean().default(false),
  })
  .strict();

type MigrationStore = Pick<CodexAppServerBindingStore, "mutate" | "withLease">;

/** Explicitly adopt the operator-confirmed native login; never infer an auth fallback. */
export async function handleCodexAuthProfileMigration(
  options: GatewayRequestHandlerOptions,
  bindingStore: MigrationStore,
): Promise<void> {
  const { respond, context, signal, hasCurrentClientAuthority } = options;
  const parsed = paramsSchema.safeParse(options.params);
  if (!parsed.success) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Expected exact session, binding, retired profile, native account and endpoint identities.",
      ),
    );
    return;
  }
  const params = parsed.data;
  const config = context.getRuntimeConfig();
  if (!listAgentIds(config).includes(params.agentId)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "Unknown agent."));
    return;
  }
  try {
    if (params.apply && !params.confirmNativeAccount) {
      throw new Error("Apply requires explicit confirmation of the native account migration.");
    }
    const assertCallerCurrent = () => {
      if (
        signal?.aborted ||
        hasCurrentClientAuthority?.() === false ||
        context.getRuntimeConfig() !== config
      ) {
        throw new Error("Auth profile migration authority or configuration changed.");
      }
    };
    assertCallerCurrent();
    const { start } = resolveCodexAppServerRuntimeOptions({
      pluginConfig: readCodexPluginConfig(config.plugins?.entries?.codex?.config),
    });
    if (start.transport !== "websocket" || start.url !== params.expectedServerUrl) {
      throw new Error("Migration requires the explicitly identified managed websocket endpoint.");
    }
    const agentDir = resolveAgentDir(config, params.agentId);
    await withAuthProfileStoreAtEffect(
      agentDir,
      { allowKeychainPrompt: false, config },
      async (reader) => {
        const authProfileStore = await reader.read();
        const assertCurrent = () => {
          assertCallerCurrent();
          reader.assertCurrent();
        };
        assertCurrent();
        if (
          authProfileStore.profiles[params.expectedAuthProfileId] ||
          config.auth?.profiles?.[params.expectedAuthProfileId] ||
          Object.values(config.auth?.order ?? {}).some((order) =>
            order.includes(params.expectedAuthProfileId),
          ) ||
          resolveCodexAppServerAuthProfileId({ store: authProfileStore, config })
        ) {
          throw new Error(
            "A saved or configured Codex auth selection still exists; resolve it before migration.",
          );
        }
        const identity = {
          kind: "session" as const,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.expectedSessionId,
        };
        const captured = await captureSessionEntryCurrentCheckAsync({
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          config,
          fields: ["authProfileOverride", "activeWriterRunId", "lifecycleRunId"],
        });
        try {
          const entry = captured.entry;
          const entryCurrent = captured.entryCurrent;
          if (
            !entry ||
            !entryCurrent ||
            entry.sessionId !== params.expectedSessionId ||
            entry.authProfileOverride !== undefined
          ) {
            throw new Error("Migration requires an idle current session without an auth override.");
          }
          const authority = createPreparedNativeSessionBindingAuthority({
            lineage: [],
            source: captured.source,
            entryChecks: [
              {
                source: entryCurrent.source,
                assertCurrent(facts) {
                  entryCurrent.assertCurrent(facts);
                  if (facts?.activeWriterRunId) {
                    throw new Error("Session has an active writer; migration refused.");
                  }
                },
              },
            ],
            assertCurrent,
          });
          const mutation = {
            kind: "clear-auth-profile" as const,
            threadId: params.expectedThreadId,
            clientId: params.expectedClientId ?? undefined,
            expectedAuthProfileId: params.expectedAuthProfileId,
            dryRun: true,
          };
          const migrate = async () => {
            await captured.assertCurrent();
            if (!(await bindingStore.mutate(identity, mutation, assertCurrent, authority))) {
              throw new Error("Binding changed or has native child ownership; migration refused.");
            }
            const request = {
              startOptions: start,
              authProfileId: null,
              authProfileStore,
              agentDir,
              config,
              timeoutMs: 20_000,
              signal,
              assertCurrent,
              assertCurrentAsync: captured.assertCurrent,
            };
            const account = await requestCodexAppServerJson({
              ...request,
              method: "account/read",
              requestParams: { refreshToken: false },
            });
            if (
              account.account?.type !== "chatgpt" ||
              account.account.email?.toLowerCase() !== params.expectedAccountEmail.toLowerCase()
            ) {
              throw new Error("The native account does not match the explicitly confirmed owner.");
            }
            const { thread } = await requestCodexAppServerJson({
              ...request,
              method: "thread/read",
              requestParams: { threadId: params.expectedThreadId, includeTurns: false },
            });
            if (
              thread.id !== params.expectedThreadId ||
              !["idle", "notLoaded"].includes(thread.status?.type ?? "")
            ) {
              throw new Error("The native thread is not idle; migration refused.");
            }
            await captured.assertCurrent();
            assertCurrent();
            if (
              params.apply &&
              !(await bindingStore.mutate(
                identity,
                { ...mutation, dryRun: false },
                assertCurrent,
                authority,
              ))
            ) {
              throw new Error(
                "Binding changed before migration committed; inspect before retrying.",
              );
            }
          };
          if (params.apply) {
            await bindingStore.withLease(identity, migrate, { assertCurrent, authority });
          } else {
            await migrate();
          }
          respond(true, {
            applied: params.apply,
            sessionId: params.expectedSessionId,
            threadId: params.expectedThreadId,
            nativeAccountVerified: true,
          });
        } finally {
          captured.release();
        }
      },
    );
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        error instanceof Error ? error.message : "Auth profile migration refused.",
      ),
    );
  }
}

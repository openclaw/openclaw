import type {
  AgentHarnessSessionForkParams,
  AgentHarnessSessionForkResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import type { CodexThreadForkResponse } from "./protocol.js";
import { sessionBindingIdentity, type CodexAppServerBindingStore } from "./session-binding.js";
import {
  listCodexUpstreamTurns,
  precheckCodexUpstreamForkBoundary,
  resolveCodexUpstreamForkBoundary,
} from "./upstream-fork-boundary.js";

function readConnectionFingerprint(ref: unknown): string | undefined {
  if (!isRecord(ref)) {
    return undefined;
  }
  return typeof ref.connectionFingerprint === "string" && ref.connectionFingerprint.trim()
    ? ref.connectionFingerprint
    : undefined;
}

export async function forkCodexUpstreamSession(
  params: AgentHarnessSessionForkParams,
  options: {
    bindingStore: CodexAppServerBindingStore;
    control: CodexSessionCatalogControl;
    resolveConfig?: () => OpenClawConfig | undefined;
  },
): Promise<AgentHarnessSessionForkResult> {
  try {
    return await options.control.withPinnedConnection(async (control) => {
      const sourceFingerprint = readConnectionFingerprint(params.upstream.ref);
      if (
        params.upstream.kind !== "codex-app-server" ||
        !sourceFingerprint ||
        sourceFingerprint !== control.connectionFingerprint
      ) {
        return {
          status: "failed",
          code: "upstream-unavailable",
          message:
            "This Codex thread is not available on the current connection. Reconnect to its host and try again.",
        };
      }
      const resolved = await resolveCodexUpstreamForkBoundary({
        ...params.source,
        threadId: params.upstream.threadId,
        control,
      });
      if (!resolved.ok) {
        return { status: "failed", code: resolved.code, message: resolved.message };
      }
      const liveTurns = await listCodexUpstreamTurns(control, params.upstream.threadId);
      const precheck = precheckCodexUpstreamForkBoundary({
        boundary: resolved.boundary,
        turns: liveTurns,
      });
      if (!precheck.ok) {
        return { status: "failed", code: precheck.code, message: precheck.message };
      }
      // beforeTurnId is experimental; the initialized shared client explicitly negotiates it.
      const rawResponse = await control.forkThread({
        threadId: params.upstream.threadId,
        ...("wholeThread" in resolved.boundary
          ? {}
          : { beforeTurnId: resolved.boundary.beforeTurnId }),
        excludeTurns: true,
      });
      let response: CodexThreadForkResponse;
      try {
        response = assertCodexThreadForkResponse(rawResponse);
      } catch (error) {
        const orphanThreadId =
          isRecord(rawResponse.thread) && typeof rawResponse.thread.id === "string"
            ? rawResponse.thread.id.trim()
            : "";
        if (orphanThreadId) {
          await control.archiveThread(orphanThreadId).catch(() => undefined);
        }
        throw error;
      }
      const threadId = response.thread.id.trim();
      if (!threadId) {
        throw new Error("Codex thread/fork response did not include a thread id");
      }
      const connectionFingerprint = control.connectionFingerprint;
      if (!connectionFingerprint) {
        throw new Error("Codex fork connection did not include a fingerprint");
      }
      let attachedIdentity: ReturnType<typeof sessionBindingIdentity> | undefined;
      return {
        status: "forked",
        upstream: {
          threadId,
          ref: { connectionFingerprint, threadId },
          marker: { turnId: null, userMessageCount: 0 },
        },
        attach: async (target) => {
          attachedIdentity = sessionBindingIdentity({
            ...target,
            config: options.resolveConfig?.(),
          });
          const attached = await options.bindingStore.mutate(attachedIdentity, {
            kind: "set",
            binding: {
              threadId,
              cwd: response.thread.cwd ?? "",
              model: response.model,
              modelProvider: response.modelProvider ?? undefined,
              historyCoveredThrough: new Date().toISOString(),
            },
          });
          if (!attached) {
            throw new Error("Codex session binding changed before the fork could be attached");
          }
        },
        archive: async () => {
          if (attachedIdentity) {
            await options.bindingStore
              .mutate(attachedIdentity, { kind: "clear", threadId })
              .catch(() => undefined);
          }
          await options.control.withPinnedConnection(async (archiveControl) => {
            if (archiveControl.connectionFingerprint !== connectionFingerprint) {
              throw new Error("Codex connection changed before orphan cleanup");
            }
            await archiveControl.archiveThread(threadId);
          });
        },
      };
    });
  } catch {
    return {
      status: "failed",
      code: "upstream-unavailable",
      message:
        "The Codex thread could not be forked. Check that Codex is available, then try again.",
    };
  }
}

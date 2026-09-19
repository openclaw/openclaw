/** Account-bound Reserve transitions for an admitted, OpenClaw-owned pending turn. */
import { isDeepStrictEqual } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { z } from "zod";
import { readCodexAppServerAuthHandoff } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";
import { listAllCodexAppServerModels } from "./models.js";
import {
  isJsonObject,
  type CodexTurnStartParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { CodexAppServerRpcError } from "./rpc-error.js";
import type {
  CodexAppServerBindingIdentity,
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./session-binding.js";
import { withAbortableTimeout } from "./timeout.js";

const RESERVE_MODEL = "gpt-reserve";
const slug = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    }),
  );
const reserveBanner = z.object({
  banner_type: z.literal("luna_reserve"),
  title: z.string().min(1).max(1024),
  description: z.string().max(4096),
  ctas: z.array(z.object({ action: z.string(), label: z.string() })).max(8),
  blocked_model_slug: slug.nullish(),
});

type ReserveReturn = NonNullable<CodexAppServerThreadBinding["reserveReturn"]>;
type TurnSettings = Pick<
  CodexTurnStartParams,
  "model" | "effort" | "serviceTier" | "collaborationMode"
>;

/** Never uses sparse notifications, quota percentages, or a saved return target as permission. */
function ordinaryUsageRecovered(value: JsonObject): boolean {
  const limits = isJsonObject(value.rateLimits) ? value.rateLimits : undefined;
  const credits = isJsonObject(limits?.credits) ? limits.credits : undefined;
  return (
    typeof value.ordinaryUsageAllowed === "boolean" &&
    (value.ordinaryUsageAllowed || credits?.hasCredits === true || credits?.unlimited === true) &&
    value.rateLimitUpsell === null &&
    limits !== undefined &&
    limits.spendControlReached !== true &&
    limits.rateLimitReachedType == null
  );
}

function settingsForModel(
  normal: CodexTurnStartParams,
  model: string,
  effort: string | null,
  serviceTier: string | null,
): TurnSettings {
  return {
    model,
    effort,
    serviceTier,
    ...(normal.collaborationMode
      ? {
          collaborationMode: {
            ...normal.collaborationMode,
            settings: { ...normal.collaborationMode.settings, model, reasoning_effort: effort },
          },
        }
      : {}),
  };
}

/** Returns only after the native task accepts settings; the caller still owns the unsent input. */
export async function prepareCodexLunaReserveTurn(options: {
  client: CodexAppServerClient;
  bindingStore: CodexAppServerBindingStore;
  identity: CodexAppServerBindingIdentity;
  binding: CodexAppServerThreadBinding;
  normal: CodexTurnStartParams;
  assertCurrent: () => void;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<TurnSettings | undefined> {
  const { client, bindingStore, identity, binding, normal, signal, timeoutMs } = options;
  // Native/adopted sessions have another model owner. API-key clients have no ChatGPT handoff.
  const account = readCodexAppServerAuthHandoff(client);
  const normalModel = normal.model;
  if (binding.preserveNativeModel || binding.connectionScope === "supervision" || !normalModel) {
    return undefined;
  }
  if (!account) {
    if (binding.reserveReturn || normal.model === RESERVE_MODEL) {
      throw new Error(
        "Luna Reserve requires the original live ChatGPT account. The pending turn was not sent.",
      );
    }
    return undefined;
  }
  return await bindingStore.withLease(identity, async () => {
    let expectedReturn = binding.reserveReturn;
    let expectedModel = binding.model;
    const assertCurrent = () => {
      signal.throwIfAborted();
      options.assertCurrent();
      const current = bindingStore.read(identity);
      if (
        readCodexAppServerAuthHandoff(client) !== account ||
        current?.threadId !== binding.threadId ||
        current.clientId !== binding.clientId ||
        current.authProfileId !== binding.authProfileId ||
        current.model !== expectedModel ||
        !isDeepStrictEqual(current.reserveReturn, expectedReturn)
      ) {
        throw new Error(
          "Codex account or thread ownership changed during Reserve selection. The pending turn was not sent.",
        );
      }
    };
    const persist = async (reserveReturn: ReserveReturn | undefined, model = expectedModel) => {
      assertCurrent();
      if (
        !(await bindingStore.mutate(
          identity,
          {
            kind: "patch",
            threadId: binding.threadId,
            patch: { reserveReturn, model },
          },
          assertCurrent,
        ))
      ) {
        throw new Error(
          "Codex Reserve state changed before it could be saved. The pending turn was not sent.",
        );
      }
      expectedReturn = reserveReturn;
      expectedModel = model;
      binding.reserveReturn = reserveReturn;
      binding.model = model;
      assertCurrent();
    };
    const request = async <T>(method: string, params?: unknown): Promise<T> => {
      assertCurrent();
      const result = await client.request<T>(method, params, { timeoutMs, signal, assertCurrent });
      assertCurrent();
      return result;
    };
    assertCurrent();
    const normalEffort =
      normal.collaborationMode?.settings.reasoning_effort ?? normal.effort ?? null;
    const normalTier = normal.serviceTier ?? null;
    if (expectedReturn && expectedReturn.accountId !== account.chatgptAccountId) {
      throw new Error(
        "The Reserve account changed. Reconnect the original account or start a new conversation; the pending turn was not sent.",
      );
    }
    if (normalModel === RESERVE_MODEL) {
      throw new Error(
        "Luna Reserve cannot be selected manually. Select an ordinary model and wait for a backend-authorized offer.",
      );
    }
    const explicitChange = expectedReturn && expectedReturn.model !== normalModel;
    if (explicitChange) {
      // A new explicit model replaces the old return target, never the new preference.
      const settings = settingsForModel(normal, normalModel, normalEffort, normalTier);
      await applyNativeSettings(client, binding.threadId, settings, {
        assertCurrent,
        signal,
        timeoutMs,
      });
      await persist(undefined, normalModel);
      return settings;
    }
    if (
      expectedReturn &&
      binding.model !== RESERVE_MODEL &&
      binding.model !== expectedReturn.model
    ) {
      throw new Error(
        "The native model changed during Reserve recovery. Select that model explicitly in OpenClaw or start a new conversation; the pending turn was not sent.",
      );
    }
    let usage: JsonValue;
    try {
      usage = await request<JsonValue>("account/rateLimits/read", {
        supportsLunaReserve: true,
        excludeResetCreditDetails: true,
      });
    } catch (error) {
      if (
        !(error instanceof CodexAppServerRpcError) ||
        (error.code !== -32600 && error.code !== -32602)
      ) {
        throw error;
      }
      // Exactly the reference client's old-server compatibility boundary; never claim support.
      await request("account/rateLimits/read");
      if (expectedReturn) {
        throw new Error(
          "This Codex app-server cannot reconcile Luna Reserve. Continue in its native client; the pending turn was not sent.",
          { cause: error },
        );
      }
      return undefined;
    }
    if (!isJsonObject(usage) || usage.accountId !== account.chatgptAccountId) {
      if (expectedReturn) {
        throw new Error(
          "Codex did not confirm the Reserve account. The pending turn was not sent.",
        );
      }
      return undefined;
    }
    const parsed = reserveBanner.safeParse(usage.rateLimitUpsell);
    const offered =
      parsed.success &&
      (!parsed.data.blocked_model_slug || parsed.data.blocked_model_slug === normalModel);
    const recovered = ordinaryUsageRecovered(usage);
    if (!offered && !expectedReturn) {
      return undefined;
    }
    if (expectedReturn && !offered && !recovered) {
      // Unknown/other banners and missing permission cannot silently restore a paid ordinary route.
      throw new Error(
        "Codex has not confirmed Reserve continuation or ordinary recovery. The pending turn was not sent.",
      );
    }
    const recovering = Boolean(expectedReturn && recovered);
    const targetModel = recovering ? normalModel : RESERVE_MODEL;
    const catalog = await listAllCodexAppServerModels({
      request: async ({ method, requestParams }) => await request(method, requestParams),
      includeHidden: true,
    });
    assertCurrent();
    const model = catalog.models.find((candidate) => candidate.model === targetModel);
    if (!model || catalog.truncated || (recovering && model.hidden)) {
      throw new Error(
        "Codex did not return the authorized Reserve model settings. The pending turn was not sent.",
      );
    }
    if (
      normal.input.some(
        (item) =>
          (item.type === "image" || item.type === "localImage") &&
          !model.inputModalities.includes("image"),
      )
    ) {
      throw new Error(
        "The authorized Reserve model cannot accept this image. The pending input was not sent.",
      );
    }
    const effort = model.supportedReasoningEfforts.includes(normalEffort ?? "")
      ? normalEffort
      : (model.defaultReasoningEffort ?? null);
    const tier = recovering
      ? normalTier
      : normal.serviceTier === null
        ? null
        : model.serviceTiers?.some((candidate) => candidate.id === normalTier)
          ? normalTier
          : (model.defaultServiceTier ?? null);
    const settings = settingsForModel(normal, targetModel, effort, tier);
    if (!expectedReturn && !recovering) {
      await persist({
        accountId: account.chatgptAccountId,
        model: normalModel,
        effort: normalEffort,
        serviceTier: normalTier,
      });
    }
    await applyNativeSettings(client, binding.threadId, settings, {
      assertCurrent,
      signal,
      timeoutMs,
    });
    await persist(recovering ? undefined : expectedReturn, targetModel);
    return settings;
  });
}

async function applyNativeSettings(
  client: CodexAppServerClient,
  threadId: string,
  settings: TurnSettings,
  options: { assertCurrent: () => void; signal: AbortSignal; timeoutMs: number },
): Promise<void> {
  const observed = createDeferred<void>();
  const detach = client.addNotificationHandler((notification) => {
    if (
      notification.method !== "thread/settings/updated" ||
      !isJsonObject(notification.params) ||
      notification.params.threadId !== threadId ||
      !isJsonObject(notification.params.threadSettings)
    ) {
      return;
    }
    const actual = notification.params.threadSettings;
    if (
      actual.model === settings.model &&
      actual.effort === settings.effort &&
      actual.serviceTier === settings.serviceTier &&
      (!settings.collaborationMode ||
        isDeepStrictEqual(actual.collaborationMode, settings.collaborationMode))
    ) {
      observed.resolve();
    }
  });
  try {
    options.assertCurrent();
    await client.request("thread/settings/update", { threadId, ...settings }, options);
    options.assertCurrent();
    // The RPC response acknowledges queueing, not application. Observe the accepted tuple.
    await withAbortableTimeout({
      promise: observed.promise,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      timeoutMessage: "Codex did not confirm Reserve task settings. The pending turn was not sent.",
    });
    options.assertCurrent();
  } finally {
    detach();
  }
}

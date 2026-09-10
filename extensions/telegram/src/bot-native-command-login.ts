import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  decideProviderLoginSessionAdoption,
  createProviderLoginFlowRegistry,
  formatProviderLoginCommand,
  formatProviderLoginCompletion,
  formatProviderLoginFailure,
  isProviderLoginPatchPersisted,
  prepareProviderChannelLogin,
  releaseProviderLoginFlow,
  reserveProviderLoginFlow,
  runProviderChannelLoginFlow,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { defaultTelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { TelegramCommandDispatch } from "./bot-native-command-dispatch.js";
import { buildTelegramRoutingTarget, resolveTelegramCommandAuthorization } from "./bot/helpers.js";

const activeTelegramProviderLoginFlows = createProviderLoginFlowRegistry();

type TelegramLoginDeviceCode = {
  title: string;
  code: string;
  expiresInMinutes?: number;
  message?: string;
};

// Telegram's inline-code entity provides the tap-to-copy affordance needed for
// short-lived device codes; plain text and literal backticks do not.
function formatTelegramLoginDeviceCode(params: TelegramLoginDeviceCode): string {
  return [
    `<b>${escapeHtml(params.title)}</b>`,
    "",
    ...(params.message ? [escapeHtml(params.message)] : []),
    `Code: <code>${escapeHtml(params.code)}</code>`,
    ...(params.expiresInMinutes
      ? [`Code expires in ${params.expiresInMinutes} minutes. Never share it.`]
      : []),
  ].join("\n");
}

function buildTelegramProviderLoginFlowKey(dispatch: TelegramCommandDispatch): string {
  const threadKey =
    dispatch.threadSpec.id == null
      ? dispatch.threadSpec.scope
      : `${dispatch.threadSpec.scope}:${dispatch.threadSpec.id}`;
  return [
    "telegram",
    dispatch.route.accountId,
    String(dispatch.chatId),
    threadKey,
    dispatch.route.agentId,
  ].join(":");
}

export async function executeTelegramLoginCommand(params: {
  dispatch: TelegramCommandDispatch;
  commandText: string;
  currentProvider?: string;
}): Promise<boolean> {
  const { dispatch } = params;
  const sendLoginMessage = async (text: string) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () => dispatch.bot.api.sendMessage(dispatch.chatId, text, dispatch.threadParams ?? {}),
    });
  };
  const sendLoginDeviceCode = async (deviceCode: TelegramLoginDeviceCode) => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () =>
        dispatch.bot.api.sendMessage(dispatch.chatId, formatTelegramLoginDeviceCode(deviceCode), {
          ...dispatch.threadParams,
          parse_mode: "HTML",
        }),
    });
  };
  const sendLoginResultMessage = async (text: string) => {
    await dispatch.telegramDeps.sendMessageTelegram(
      buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec),
      text,
      {
        cfg: dispatch.runtimeCfg,
        token: dispatch.opts.token,
        accountId: dispatch.route.accountId,
      },
    );
  };
  const prepared = await prepareProviderChannelLogin({
    commandText: params.commandText,
    commandAuthorized: dispatch.commandAuthorized,
    senderIsOwner: dispatch.senderIsOwner,
    isPrivateChat: dispatch.msg.chat.type === "private",
    config: dispatch.runtimeCfg,
    agentId: dispatch.route.agentId,
    signal: dispatch.opts.accountAbortSignal,
  });
  if (!prepared) {
    return false;
  }
  if (prepared.status !== "ready") {
    if (!prepared.reply.presentation) {
      await sendLoginMessage(prepared.reply.text);
      return prepared.status === "reply";
    }
    const { deliverReplies } = await dispatch.loadDeliveryRuntime();
    const result = await deliverReplies({
      replies: [prepared.reply],
      ...dispatch.buildDeliveryBaseOptions({
        sessionKeyForInternalHooks: dispatch.targetSessionKey,
        policySessionKey: dispatch.targetSessionKey,
      }),
    });
    return result.delivered && prepared.status === "reply";
  }
  const loginChoice = prepared.choice;
  const flowKey = buildTelegramProviderLoginFlowKey(dispatch);
  const reservation = reserveProviderLoginFlow({
    flows: activeTelegramProviderLoginFlows,
    flowKey,
  });
  if (reservation.status === "active") {
    await sendLoginMessage(
      `${loginChoice.providerLabel} login is already active for this Telegram chat. Complete it, or wait for it to expire before requesting a new one.`,
    );
    return true;
  }
  const flowSignal = dispatch.opts.accountAbortSignal
    ? AbortSignal.any([reservation.record.signal, dispatch.opts.accountAbortSignal])
    : reservation.record.signal;
  const assertCurrent = (config = dispatch.telegramDeps.getRuntimeConfig()) => {
    const authorization = resolveTelegramCommandAuthorization({
      cfg: config,
      accountId: dispatch.route.accountId,
      chatId: dispatch.chatId,
      isGroup: dispatch.isGroup,
      threadSpec: dispatch.threadSpec,
      senderId: dispatch.senderId,
      senderUsername: dispatch.senderUsername,
      commandAuthorized: dispatch.commandAuthorized,
    });
    if (!authorization.senderIsOwner || !authorization.isAuthorizedSender) {
      throw new Error("Provider login authority is no longer active.");
    }
  };
  const signInActionDelivered = createDeferred<void>();
  let signInActionWasDelivered = false;
  // Sign-in action delivery releases Telegram's serialized chat lane. The
  // reservation and account signal still own polling through completion.
  const completion = (async () => {
    let terminalMessage: string;
    try {
      const targetSessionEntryAtStart = dispatch.nativeCommandRuntime.getSessionEntry({
        agentId: dispatch.route.agentId,
        sessionKey: dispatch.targetSessionKey,
      });
      const loginResult = await runProviderChannelLoginFlow({
        runLoginFlow:
          dispatch.telegramDeps.runModelsAuthLoginFlow ??
          defaultTelegramNativeCommandDeps.runModelsAuthLoginFlow,
        choice: loginChoice,
        agentId: dispatch.route.agentId,
        config: dispatch.runtimeCfg,
        readConfig: dispatch.telegramDeps.getRuntimeConfig,
        runtime: dispatch.runtime,
        signal: flowSignal,
        assertCurrent,
        sendMessage: sendLoginMessage,
        sendDeviceCode: async (deviceCode) => {
          flowSignal.throwIfAborted();
          await sendLoginDeviceCode(deviceCode);
          flowSignal.throwIfAborted();
          signInActionWasDelivered = true;
          signInActionDelivered.resolve();
        },
        unsupportedPromptMessage:
          "This provider needs input that Telegram cannot collect. Open Control UI → Models and choose Sign in.",
      });
      flowSignal.throwIfAborted();
      const nextProfileId = loginResult.profiles.find(
        (profile) =>
          normalizeLowercaseStringOrEmpty(profile.provider) ===
          normalizeLowercaseStringOrEmpty(loginChoice.providerId),
      )?.profileId;
      let sessionSwitchFailed = !nextProfileId;
      if (
        nextProfileId &&
        normalizeLowercaseStringOrEmpty(params.currentProvider) ===
          normalizeLowercaseStringOrEmpty(loginChoice.providerId)
      ) {
        const storePath = resolveStorePath(dispatch.runtimeCfg.session?.store, {
          agentId: dispatch.route.agentId,
        });
        let entryObserved = false;
        let adoptionDecision: ReturnType<typeof decideProviderLoginSessionAdoption> | undefined;
        try {
          const persisted = await patchSessionEntry({
            sessionKey: dispatch.targetSessionKey,
            storePath,
            requireWriteSuccess: true,
            skipMaintenance: true,
            assertCommitAllowed: () => {
              flowSignal.throwIfAborted();
              assertCurrent();
            },
            update: (entry) => {
              entryObserved = true;
              adoptionDecision = decideProviderLoginSessionAdoption({
                currentModelProvider: params.currentProvider,
                loginProvider: loginChoice.providerId,
                nextProfileId,
                snapshot: targetSessionEntryAtStart,
                current: entry,
              });
              return adoptionDecision.status === "patch" ? adoptionDecision.patch : null;
            },
          });
          flowSignal.throwIfAborted();
          if (
            entryObserved &&
            (adoptionDecision?.status === "rejected" ||
              !persisted ||
              (adoptionDecision?.status === "patch" &&
                !isProviderLoginPatchPersisted(persisted, nextProfileId)))
          ) {
            sessionSwitchFailed = true;
          }
        } catch (error) {
          flowSignal.throwIfAborted();
          dispatch.runtime.error?.(
            danger(
              `telegram ${formatProviderLoginCommand(loginChoice)} completed but failed to update session auth profile: ${String(
                error,
              )}`,
            ),
          );
          sessionSwitchFailed = true;
        }
      }
      terminalMessage = formatProviderLoginCompletion(
        loginChoice,
        loginResult.authRefresh,
        sessionSwitchFailed,
        "Telegram session",
      );
    } catch (error) {
      if (flowSignal.aborted) {
        return;
      }
      dispatch.runtime.error?.(
        danger(`telegram ${formatProviderLoginCommand(loginChoice)} failed: ${String(error)}`),
      );
      terminalMessage = formatProviderLoginFailure(loginChoice, error);
    }
    if (flowSignal.aborted) {
      return;
    }
    try {
      await sendLoginResultMessage(terminalMessage);
    } catch (error) {
      dispatch.runtime.error?.(
        danger(
          `telegram ${formatProviderLoginCommand(loginChoice)} result notification failed: ${String(error)}`,
        ),
      );
    }
  })().finally(() => {
    releaseProviderLoginFlow({
      flows: activeTelegramProviderLoginFlows,
      flowKey,
      record: reservation.record,
    });
  });
  await Promise.race([signInActionDelivered.promise, completion]);
  return signInActionWasDelivered;
}

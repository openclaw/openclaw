import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  cancelProviderLoginFlow,
  answerProviderLoginModelAccess,
  offerProviderLoginModelAccess,
  type PreparedProviderModelAccess,
  decideProviderLoginSessionAdoption,
  createProviderLoginFlowRegistry,
  formatProviderLoginCommand,
  formatProviderLoginCompletion,
  formatProviderLoginFailure,
  isProviderLoginPatchPersisted,
  prepareProviderChannelLogin,
  refreshProviderLoginAuthState,
  releaseProviderLoginFlow,
  reserveProviderLoginFlow,
  runProviderChannelLoginFlow,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  prepareSessionEntryPatch,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeHtml } from "openclaw/plugin-sdk/text-utility-runtime";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { defaultTelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { TelegramCommandDispatch } from "./bot-native-command-dispatch.js";
import { buildTelegramRoutingTarget } from "./bot/helpers.js";

const activeTelegramProviderLoginFlows = createProviderLoginFlowRegistry();

type TelegramLoginDeviceCode = Parameters<
  NonNullable<Parameters<typeof runProviderChannelLoginFlow>[0]["sendDeviceCode"]>
>[0];

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

export async function executeTelegramLoginCommand(params: {
  dispatch: TelegramCommandDispatch;
  commandText: string;
  currentProvider?: string;
}): Promise<boolean> {
  const { dispatch } = params;
  const threadKey =
    dispatch.threadSpec.id == null
      ? dispatch.threadSpec.scope
      : `${dispatch.threadSpec.scope}:${dispatch.threadSpec.id}`;
  const flow = {
    flows: activeTelegramProviderLoginFlows,
    flowKey: [
      "telegram",
      dispatch.route.accountId,
      String(dispatch.chatId),
      threadKey,
      dispatch.route.agentId,
    ].join(":"),
  };
  const sendLoginMessage = async (text: string, parseMode?: "HTML") => {
    await withTelegramApiErrorLogging({
      operation: "sendMessage",
      runtime: dispatch.runtime,
      fn: () =>
        dispatch.bot.api.sendMessage(dispatch.chatId, text, {
          ...dispatch.threadParams,
          ...(parseMode ? { parse_mode: parseMode } : {}),
        }),
    });
  };
  const assertCurrent = (config = dispatch.telegramDeps.getRuntimeConfig()) => {
    dispatch.assertOwnerCurrent?.();
    const authorization = resolveCommandAuthorization({
      cfg: config,
      ctx: dispatch.ownerContext,
      commandAuthorized: dispatch.commandAuthorized,
    });
    if (
      !dispatch.senderIsOwner ||
      !authorization.senderIsOwner ||
      !authorization.isAuthorizedSender
    ) {
      throw new Error("Provider login authority is no longer active.");
    }
  };
  const sendLoginReply = async (reply: ReplyPayload) => {
    const { deliverReplies } = await dispatch.loadDeliveryRuntime();
    const result = await deliverReplies({
      replies: [reply],
      ...dispatch.deliveryOptions,
    });
    return result.delivered;
  };
  const prepared = await prepareProviderChannelLogin({
    commandText: params.commandText,
    commandAuthorized: dispatch.commandAuthorized,
    senderIsOwner: dispatch.senderIsOwner,
    isPrivateChat: dispatch.msg.chat.type === "private",
    config: dispatch.runtimeCfg,
    agentId: dispatch.route.agentId,
    signal: dispatch.opts.accountAbortSignal,
    refreshAuth: () =>
      refreshProviderLoginAuthState({
        agentId: dispatch.route.agentId,
        readConfig: dispatch.telegramDeps.getRuntimeConfig,
        assertCurrent: (config) => {
          dispatch.opts.accountAbortSignal?.throwIfAborted();
          assertCurrent(config);
        },
      }),
    cancelLogin: () => cancelProviderLoginFlow(flow),
    answerChoice: (command) =>
      answerProviderLoginModelAccess({
        ...flow,
        command,
        agentId: dispatch.route.agentId,
        readConfig: dispatch.telegramDeps.getRuntimeConfig,
        runtime: dispatch.runtime,
        signal: dispatch.opts.accountAbortSignal,
        assertCurrent,
      }),
  });
  if (!prepared) {
    return false;
  }
  if (prepared.status !== "ready") {
    if (!prepared.reply.presentation) {
      await sendLoginMessage(prepared.reply.text);
      return prepared.status === "reply";
    }
    return (await sendLoginReply(prepared.reply)) && prepared.status === "reply";
  }
  const loginChoice = prepared.choice;
  const reservation = reserveProviderLoginFlow({
    ...flow,
    providerLabel: loginChoice.providerLabel,
    signal: dispatch.opts.accountAbortSignal,
  });
  if (reservation.status === "active") {
    await sendLoginMessage(
      `${reservation.providerLabel} sign-in is already in progress. Finish it, or send /login cancel to cancel.`,
    );
    return true;
  }
  const flowSignal = reservation.record.signal;

  const signInActionDelivered = createDeferred<void>();
  let signInActionWasDelivered = false;
  const sendLoginAction = async (send: () => Promise<boolean | void>) => {
    flowSignal.throwIfAborted();
    if ((await send()) === false) {
      throw new Error("Provider sign-in action could not be delivered.");
    }
    flowSignal.throwIfAborted();
    signInActionWasDelivered = true;
    signInActionDelivered.resolve();
  };
  // Sign-in action delivery releases Telegram's serialized chat lane. The
  // reservation and account signal still own polling through completion.
  const completion = (async () => {
    let terminalMessage: string;
    let modelAccess: PreparedProviderModelAccess | undefined;
    try {
      const targetSessionEntryAtStart = await dispatch.nativeCommandRuntime.getSessionEntryAsync({
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
        sendReply: (reply) => sendLoginAction(() => sendLoginReply(reply)),
        onModelAccessRequested: (request) => {
          modelAccess = request;
        },
        sendDeviceCode: (deviceCode) =>
          sendLoginAction(() =>
            sendLoginMessage(formatTelegramLoginDeviceCode(deviceCode), "HTML"),
          ),
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
        let adoptionDecision: ReturnType<typeof decideProviderLoginSessionAdoption> | undefined;
        try {
          const persisted = await prepareSessionEntryPatch({
            sessionKey: dispatch.targetSessionKey,
            storePath,
            requireWriteSuccess: true,
            skipMaintenance: true,
            authority: {
              kind: "host",
              assertCurrent() {
                flowSignal.throwIfAborted();
                assertCurrent();
              },
            },
            prepare: (entry) => {
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
            adoptionDecision &&
            (adoptionDecision.status === "rejected" ||
              !persisted ||
              (adoptionDecision.status === "patch" &&
                !isProviderLoginPatchPersisted(persisted, nextProfileId)))
          ) {
            sessionSwitchFailed = true;
          }
        } catch (error) {
          flowSignal.throwIfAborted();
          dispatch.runtime.error?.(
            danger(
              `telegram ${formatProviderLoginCommand(loginChoice.command)} completed but failed to update session auth profile: ${String(
                error,
              )}`,
            ),
          );
          sessionSwitchFailed = true;
        }
      }
      const sessionModel =
        targetSessionEntryAtStart?.modelOverride ?? targetSessionEntryAtStart?.model;
      terminalMessage = formatProviderLoginCompletion(
        loginChoice,
        loginResult.authRefresh,
        sessionSwitchFailed,
        nextProfileId && sessionModel
          ? { model: sessionModel, profileId: nextProfileId }
          : undefined,
      );
    } catch (error) {
      modelAccess = undefined;
      if (flowSignal.aborted) {
        return;
      }
      dispatch.runtime.error?.(
        danger(
          `telegram ${formatProviderLoginCommand(loginChoice.command)} failed: ${String(error)}`,
        ),
      );
      terminalMessage = formatProviderLoginFailure(loginChoice, error);
    }
    if (flowSignal.aborted) {
      return;
    }
    try {
      if (modelAccess) {
        const reply = offerProviderLoginModelAccess({
          ...flow,
          prepared: modelAccess,
          terminalMessage,
        });
        await sendLoginAction(() => sendLoginReply(reply));
      } else {
        await dispatch.telegramDeps.sendMessageTelegram(
          buildTelegramRoutingTarget(dispatch.chatId, dispatch.threadSpec),
          terminalMessage,
          {
            cfg: dispatch.runtimeCfg,
            token: dispatch.opts.token,
            accountId: dispatch.route.accountId,
          },
        );
      }
    } catch (error) {
      dispatch.runtime.error?.(
        danger(
          `telegram ${formatProviderLoginCommand(loginChoice.command)} result notification failed: ${String(error)}`,
        ),
      );
    }
  })().finally(() => {
    releaseProviderLoginFlow({
      ...flow,
      record: reservation.record,
    });
  });
  await Promise.race([signInActionDelivered.promise, completion]);
  return signInActionWasDelivered;
}

import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { buildQaTarget, parseQaTarget } from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaRunnerCliRegistration } from "openclaw/plugin-sdk/qa-runner-runtime";
import {
  assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease,
} from "../../gateway-process-boundary.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import { buildTelegramQaConfig, waitForTelegramChannelRunning } from "./telegram-api.runtime.js";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import {
  loadTelegramUserbotSkillRuntime,
  type TelegramTestCredential,
} from "./userbot-skill.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;

const TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT = 9_999;

type TelegramQaObserverState = {
  filteredCount: number;
  matchedCount: number;
  relevantUpdateKinds: Set<"edit" | "message">;
  updateCount: number;
};

function renderTelegramQaDiagnosticCount(value: number) {
  return value > TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT
    ? `${TELEGRAM_QA_DIAGNOSTIC_COUNT_LIMIT}+`
    : String(value);
}

function describeTelegramQaObserverState(state: TelegramQaObserverState) {
  const updateKinds =
    state.relevantUpdateKinds.size > 0 ? [...state.relevantUpdateKinds] : ["none"];
  return [
    `telegram userbot updates=${renderTelegramQaDiagnosticCount(state.updateCount)}`,
    `filtered=${renderTelegramQaDiagnosticCount(state.filteredCount)}`,
    `matched=${renderTelegramQaDiagnosticCount(state.matchedCount)}`,
    `update kinds=[${updateKinds.join(",")}]`,
  ].join("; ");
}

function renderTelegramQaInboundText(
  input: { text: string; nativeCommand?: { name: string } },
  botUsername: string,
) {
  const commandName = input.nativeCommand?.name.trim().toLowerCase();
  const renderedText = input.text.replaceAll("@openclaw", `@${botUsername}`);
  const commandToken = renderedText.match(/^\S+/u)?.[0];
  return commandName && commandToken?.toLowerCase() === `/${commandName}`
    ? `/${commandName}@${botUsername}${renderedText.slice(commandToken.length)}`
    : renderedText;
}

async function releaseTelegramCredential(params: {
  heartbeat: { stop(): Promise<void> };
  release(): Promise<void>;
}) {
  try {
    await params.heartbeat.stop();
  } finally {
    await params.release();
  }
}

export async function createTelegramQaTransportAdapter(
  context: FactoryContext,
): Promise<AdapterDefinition> {
  const options = context.adapterOptions ?? {};
  const skillRuntime = await loadTelegramUserbotSkillRuntime({ repoRoot: options.repoRoot });
  const credentialLease = await acquireQaCredentialLease<TelegramTestCredential>({
    kind: "telegram-test-userbot",
    source: options.credentialSource || "convex",
    role: options.credentialRole,
    resolveEnvPayload: () => {
      throw new Error("Telegram live QA requires a Convex-leased Test Server userbot.");
    },
    parsePayload: (payload) => skillRuntime.parseCredential(payload),
  });
  try {
    assertQaGatewayCredentialLeaseQuarantine(credentialLease);
  } catch (error) {
    await credentialLease.release();
    throw error;
  }
  const heartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const leaseHealth = {
    assertHealthy: () => heartbeat.throwIfFailed(),
    whenUnhealthy: heartbeat.whenFailed,
  };
  let leaseReleased = false;
  const releaseCredentialLease = async () => {
    if (leaseReleased) {
      return;
    }
    await releaseTelegramCredential({ heartbeat, release: () => credentialLease.release() });
    leaseReleased = true;
  };
  let stateRoot: string | undefined;
  let apiProxy: Awaited<ReturnType<typeof skillRuntime.startApiProxy>> | undefined;
  let userbot: TelegramUserbotDriver | undefined;
  const participants = [
    { alias: "primary", credential: credentialLease.payload },
    ...(credentialLease.payload.participants ?? []).map((participant) => ({
      alias: participant.alias,
      credential: { ...credentialLease.payload, ...participant, participants: undefined },
    })),
  ];
  const drivers: TelegramUserbotDriver[] = [];
  const participantRoots: string[] = [];
  let primaryAlias: string | undefined;
  let participantCleanupUncertain = false;
  const closeParticipants = async () => {
    const results = await Promise.allSettled(drivers.map((driver) => driver.close()));
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    participantCleanupUncertain ||= errors.length > 0;
    return errors;
  };
  const observerState: TelegramQaObserverState = {
    filteredCount: 0,
    matchedCount: 0,
    relevantUpdateKinds: new Set(),
    updateCount: 0,
  };
  const accountId = options.sutAccountId?.trim() || "sut";
  const directMessageOnly = options.transportPolicy?.directMessageOnly === true;
  type Route = {
    id: string;
    kind: "channel" | "direct" | "group";
    threadId?: string;
    bound?: true;
  };
  const routes = new Map<string, Route>();
  const nativeKey = (observer: number, chatId: number, messageId: number) =>
    `${observer}:${chatId}:${messageId}`;
  const routeKey = (observer: number, chatId: number, topic?: number) =>
    `${observer}:${chatId}:${topic ?? ""}`;
  const initialChatId = Number(
    directMessageOnly ? credentialLease.payload.sutBotId : credentialLease.payload.groupId,
  );
  const resetRoutes = () => {
    routes.clear();
    routes.set(routeKey(0, initialChatId), {
      id: credentialLease.payload.groupId,
      kind: directMessageOnly ? "direct" : "channel",
    });
  };
  resetRoutes();
  const nativeMessageIds = new Map<
    string,
    { observer: number; chatId: number; messageId: number }
  >();
  const busMessages = new Map<string, { id: string; update?: TelegramUserbotUpdate }>();
  let sendsInFlight = 0;
  let deferredReplies: Array<{ update: TelegramUserbotUpdate; observer: number }> = [];

  const publishUpdate = async (update: TelegramUserbotUpdate, observer: number) => {
    const key = nativeKey(observer, update.chatId, update.messageId);
    const existing = busMessages.get(key);
    if (update.kind === "edit" && existing) {
      await context.messages.editMessage({
        accountId,
        messageId: existing.id,
        text: update.text,
        timestamp: update.timestamp,
      });
      existing.update = update;
      return;
    }
    const route = routes.get(routeKey(observer, update.chatId, update.forumTopicId));
    if (!route) {
      return;
    }
    const outbound = await context.messages.addOutboundMessage({
      accountId,
      to: buildQaTarget({
        chatType: route.kind,
        conversationId: route.id,
        threadId: route.threadId,
      }),
      senderId: String(update.senderId),
      senderName: update.senderUsername,
      text: update.text,
      timestamp: update.timestamp,
      replyToId: update.replyToMessageId
        ? busMessages.get(nativeKey(observer, update.chatId, update.replyToMessageId))?.id
        : undefined,
    });
    nativeMessageIds.set(outbound.id, {
      observer,
      chatId: update.chatId,
      messageId: update.messageId,
    });
    busMessages.set(key, { id: outbound.id, update });
  };

  const observeUpdate = async (update: TelegramUserbotUpdate, observer: number) => {
    observerState.updateCount += 1;
    observerState.relevantUpdateKinds.add(update.kind);
    if (
      !routes.has(routeKey(observer, update.chatId, update.forumTopicId)) ||
      update.senderId !== Number(credentialLease.payload.sutBotId)
    ) {
      observerState.filteredCount += 1;
      return;
    }
    observerState.matchedCount += 1;
    if (
      sendsInFlight > 0 &&
      update.replyToMessageId &&
      !busMessages.has(nativeKey(observer, update.chatId, update.replyToMessageId))
    ) {
      deferredReplies.push({ update, observer });
      return;
    }
    await publishUpdate(update, observer);
  };

  try {
    stateRoot = skillRuntime.createStateRoot();
    const restored = skillRuntime.restoreCredential(credentialLease.payload, stateRoot);
    apiProxy = await skillRuntime.startApiProxy(leaseHealth);
    await apiProxy.drainUpdates(restored.sutToken);
    userbot = await TelegramUserbotDriver.start({
      chatId: directMessageOnly ? `@${credentialLease.payload.sutUsername}` : restored.groupId,
      ...(credentialLease.payload.forumGroupId
        ? { observeChatIds: [credentialLease.payload.forumGroupId] }
        : {}),
      expectedUserId: credentialLease.payload.testerUserId,
      driverEnv: restored.driverEnv,
      leaseHealth,
      userDriverPath: skillRuntime.userDriverPath,
      onUpdate: (update) => observeUpdate(update, 0),
    });
    drivers.push(userbot);
    for (const [offset, participant] of participants.slice(1).entries()) {
      const root = skillRuntime.createStateRoot();
      participantRoots.push(root);
      const restoredParticipant = skillRuntime.restoreCredential(participant.credential, root);
      drivers.push(
        await TelegramUserbotDriver.start({
          chatId: directMessageOnly ? `@${credentialLease.payload.sutUsername}` : restored.groupId,
          expectedUserId: participant.credential.testerUserId,
          driverEnv: restoredParticipant.driverEnv,
          leaseHealth,
          userDriverPath: skillRuntime.userDriverPath,
          onUpdate: (update) => observeUpdate(update, offset + 1),
        }),
      );
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    cleanupErrors.push(...(await closeParticipants()));
    try {
      await apiProxy?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (!participantCleanupUncertain) {
      for (const root of participantRoots) {
        fs.rmSync(root, { recursive: true, force: true });
      }
      if (stateRoot) {
        fs.rmSync(stateRoot, { recursive: true, force: true });
      }
    }
    try {
      if (participantCleanupUncertain) {
        try {
          await credentialLease.heartbeat();
        } finally {
          await heartbeat.stop();
        }
      } else {
        await releaseCredentialLease();
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Telegram userbot setup and cleanup failed", {
        cause: error,
      });
    }
    throw error;
  }

  if (!userbot || !apiProxy || !stateRoot) {
    throw new Error("Telegram userbot runtime did not start.");
  }
  const activeApiProxy = apiProxy;
  const activeStateRoot = stateRoot;
  let observerStopped = false;
  let apiProxyClosed = false;
  return {
    id: "telegram",
    label: "Telegram live",
    accountId,
    requiredPluginIds: ["telegram"],
    supportedActions: [],
    assertTransportHealthy() {
      for (const driver of drivers) {
        driver.assertHealthy();
      }
      heartbeat.throwIfFailed();
    },
    describeTransportState: () => describeTelegramQaObserverState(observerState),
    async sendInbound(input) {
      heartbeat.throwIfFailed();
      let observer = participants.findIndex(
        (participant) =>
          participant.alias === input.senderId ||
          participant.credential.testerUserId === input.senderId,
      );
      if (observer < 0) {
        if (participants.length > 1) {
          throw new Error(
            "Telegram QA sender requires primary or a named leased participant alias.",
          );
        }
        primaryAlias ??= input.senderId;
        if (!input.senderId || input.senderId !== primaryAlias) {
          throw new Error(
            "Telegram QA sender requires a named leased participant; labels cannot impersonate another user.",
          );
        }
        observer = 0;
      }
      const participant = participants[observer];
      const driver = drivers[observer];
      if (!participant || !driver) {
        throw new Error("Telegram QA participant driver is unavailable.");
      }
      if (directMessageOnly && input.conversation.kind !== "direct") {
        throw new Error("Telegram QA direct-message-only policy rejects group sends.");
      }
      const forumTopicId = input.threadId === undefined ? undefined : Number(input.threadId);
      if (
        forumTopicId !== undefined &&
        (!Number.isSafeInteger(forumTopicId) ||
          forumTopicId <= 0 ||
          input.conversation.kind === "direct")
      ) {
        throw new Error(
          "Telegram QA forum sends require a positive numeric topic and a group conversation.",
        );
      }
      const chatId =
        input.conversation.kind === "direct"
          ? Number(credentialLease.payload.sutBotId)
          : Number(
              forumTopicId
                ? (credentialLease.payload.forumGroupId ?? credentialLease.payload.groupId)
                : credentialLease.payload.groupId,
            );
      // Shared rooms use one observer. TDLib message IDs belong to the observing account.
      const routeObserver = input.conversation.kind === "direct" ? observer : 0;
      const routeId = routeKey(routeObserver, chatId, forumTopicId);
      const previous = routes.get(routeId);
      if (
        previous?.bound &&
        (previous.id !== input.conversation.id || previous.kind !== input.conversation.kind)
      ) {
        throw new Error(
          "Telegram QA chat/topic already belongs to another logical conversation; reset transport before reusing it.",
        );
      }
      routes.set(routeId, { ...input.conversation, threadId: input.threadId, bound: true });
      const reply = input.replyToId ? nativeMessageIds.get(input.replyToId) : undefined;
      if (input.replyToId && (!reply || reply.observer !== observer || reply.chatId !== chatId)) {
        throw new Error(
          "Telegram QA reply requires a message observed by this participant in this chat.",
        );
      }
      const text = renderTelegramQaInboundText(input, credentialLease.payload.sutUsername);
      sendsInFlight += 1;
      try {
        const sent = await driver.send({
          text,
          chatId: String(chatId),
          ...(forumTopicId === undefined ? {} : { forumTopicId }),
          replyToMessageId: reply?.messageId,
        });
        if (
          String(sent.senderId) !== participant.credential.testerUserId ||
          sent.chatId !== chatId ||
          (forumTopicId !== undefined && sent.forumTopicId !== forumTopicId)
        ) {
          throw new Error(
            "Telegram send receipt does not match the leased participant and requested chat/topic.",
          );
        }
        const message = await context.messages.addInboundMessage({
          ...input,
          accountId,
          senderId: participant.credential.testerUserId,
        });
        nativeMessageIds.set(message.id, { observer, chatId, messageId: sent.messageId });
        busMessages.set(nativeKey(observer, chatId, sent.messageId), { id: message.id });
        // A shared-room reply can quote an ID in another user's private TDLib sequence.
        // Preserve the reply without claiming a cross-account quote relationship.
        const readyReplies = deferredReplies;
        deferredReplies = [];
        for (const entry of readyReplies) {
          await publishUpdate(entry.update, entry.observer);
        }
        return message;
      } finally {
        sendsInFlight -= 1;
      }
    },
    resetTransport: () => {
      resetRoutes();
      primaryAlias = undefined;
      nativeMessageIds.clear();
      busMessages.clear();
      deferredReplies = [];
      observerState.updateCount = 0;
      observerState.filteredCount = 0;
      observerState.matchedCount = 0;
      observerState.relevantUpdateKinds.clear();
    },
    async prepareFlow({ config }) {
      if (
        config.requireParticipantIdentityFixture === true &&
        (participants.length < 2 ||
          !credentialLease.payload.forumGroupId ||
          !credentialLease.payload.forumTopicId)
      ) {
        throw new Error(
          "Telegram participant identity proof requires one leased credential with distinct participants, forumGroupId, and forumTopicId.",
        );
      }
      return {
        telegramIdentityFixture: {
          participantAliases: participants.map((participant) => participant.alias),
          forumTopicId: credentialLease.payload.forumTopicId,
        },
        readTelegramMessages: () => {
          for (const driver of drivers) {
            driver.assertHealthy();
          }
          heartbeat.throwIfFailed();
          // Share the existing message lifetime; readers cannot mutate a later snapshot.
          return [...busMessages.values()].flatMap(({ update }) =>
            update ? [structuredClone(update)] : [],
          );
        },
      };
    },
    createGatewayConfig: () =>
      buildTelegramQaConfig({} as OpenClawConfig, {
        apiRoot: activeApiProxy.apiRoot,
        directMessageOnly,
        enableDirectMessages: true,
        additionalTesterUserIds: participants
          .slice(1)
          .map((participant) => participant.credential.testerUserId),
        forumGroupId: credentialLease.payload.forumGroupId,
        groupId: credentialLease.payload.groupId,
        sutToken: credentialLease.payload.sutToken,
        testerUserId: credentialLease.payload.testerUserId,
        sutAccountId: accountId,
      }),
    waitReady: async ({ gateway, timeoutMs, pollIntervalMs }) =>
      await waitForTelegramChannelRunning(gateway, accountId, {
        timeoutMs,
        pollMs: pollIntervalMs,
      }),
    buildAgentDelivery: ({ target, threadId }) => {
      const parsed = parseQaTarget(target);
      const topic = threadId ?? parsed?.threadId;
      const to =
        parsed?.chatType === "direct" || directMessageOnly
          ? credentialLease.payload.testerUserId
          : topic
            ? (credentialLease.payload.forumGroupId ?? credentialLease.payload.groupId)
            : credentialLease.payload.groupId;
      return {
        channel: "telegram",
        to,
        replyChannel: "telegram",
        replyTo: to,
        ...(topic ? { threadId: topic } : {}),
      };
    },
    async handleAction() {
      throw new Error("Telegram live QA adapter does not implement transport actions");
    },
    createReportNotes: () => ["Runs through the Telegram Test Server userbot adapter."],
    async cleanup() {
      if (observerStopped) {
        return;
      }
      observerStopped = true;
      const errors = await closeParticipants();
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Telegram participant cleanup is unconfirmed; retained private state and lease.",
        );
      }
      for (const root of [activeStateRoot, ...participantRoots]) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    async cleanupAfterGatewayStop() {
      const cleanupErrors: unknown[] = [];
      if (!apiProxyClosed) {
        try {
          await activeApiProxy.close();
          apiProxyClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (participantCleanupUncertain || (await shouldRetainQaGatewayCredentialLease())) {
        try {
          await credentialLease.heartbeat();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await heartbeat.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        throw new Error(
          "retained Telegram credential lease for two hours because participant or isolated SUT quiescence was not proven",
          cleanupErrors.length > 0 ? { cause: new AggregateError(cleanupErrors) } : undefined,
        );
      }
      try {
        await releaseCredentialLease();
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length === 1) {
        throw cleanupErrors[0];
      }
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, "Telegram userbot cleanup failed");
      }
    },
  };
}

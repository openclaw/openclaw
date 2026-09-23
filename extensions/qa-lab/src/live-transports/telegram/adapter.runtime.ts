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
import {
  readTelegramPrivateProductionDescriptor,
  requestTelegramPrivateAppTurn,
  resolveTelegramPrivateProductionBot,
} from "./private-production.runtime.js";
import { buildTelegramQaConfig, waitForTelegramChannelRunning } from "./telegram-api.runtime.js";
import { TelegramUserbotDriver, type TelegramUserbotUpdate } from "./userbot-driver.runtime.js";
import {
  loadTelegramUserbotSkillRuntime,
  type TelegramTestCredential,
} from "./userbot-skill.runtime.js";

type AdapterFactory = NonNullable<QaRunnerCliRegistration["adapterFactory"]>;
type FactoryContext = Parameters<AdapterFactory["create"]>[0];
type AdapterDefinition = Awaited<ReturnType<AdapterFactory["create"]>>;
type TelegramUserbotSkillRuntime = Awaited<ReturnType<typeof loadTelegramUserbotSkillRuntime>>;

type TelegramRuntimeCredential = Pick<
  TelegramTestCredential,
  | "forumGroupId"
  | "forumTopicId"
  | "groupId"
  | "participants"
  | "sutBotId"
  | "sutToken"
  | "sutUsername"
  | "testerUserId"
> & {
  environment: "production" | "test";
};

type TelegramRuntimeParticipant = {
  alias: string;
  credential?: TelegramRuntimeCredential;
  mode: "hitl" | "userbot";
  testerUserId: string;
};

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
  const privateDescriptor = readTelegramPrivateProductionDescriptor(options.credentialFile);
  const privateProduction = privateDescriptor !== undefined;
  const skillRuntime = privateProduction
    ? undefined
    : await loadTelegramUserbotSkillRuntime({ repoRoot: options.repoRoot });
  const leasedRuntime = privateProduction
    ? undefined
    : await (async () => {
        const credentialLease = await acquireQaCredentialLease<TelegramRuntimeCredential>({
          kind: "telegram-test-userbot",
          source: options.credentialSource || "convex",
          role: options.credentialRole,
          resolveEnvPayload: () => {
            throw new Error("Telegram live QA requires a Convex-leased userbot.");
          },
          parsePayload: (payload) => skillRuntime!.parseCredential(payload),
        });
        try {
          assertQaGatewayCredentialLeaseQuarantine(credentialLease);
        } catch (error) {
          await credentialLease.release();
          throw error;
        }
        return {
          credential: credentialLease.payload,
          credentialLease,
          heartbeat: startQaCredentialLeaseHeartbeat(credentialLease),
        };
      })();
  const privateBot = privateProduction
    ? await resolveTelegramPrivateProductionBot(process.env)
    : undefined;
  const credential: TelegramRuntimeCredential = privateDescriptor
    ? {
        environment: "production",
        forumGroupId: privateDescriptor.forumGroupId,
        forumTopicId: privateDescriptor.forumTopicId,
        groupId: privateDescriptor.forumGroupId,
        participants: undefined,
        sutBotId: privateBot!.id,
        sutToken: privateBot!.token,
        sutUsername: privateBot!.username,
        testerUserId: privateDescriptor.participants[0]!.userId,
      }
    : leasedRuntime!.credential;
  const leaseHealth = {
    assertHealthy: () => leasedRuntime?.heartbeat.throwIfFailed(),
    whenUnhealthy: leasedRuntime?.heartbeat.whenFailed ?? new Promise<Error>(() => {}),
  };
  let leaseReleased = false;
  const releaseCredentialLease = async () => {
    if (leaseReleased || !leasedRuntime) {
      return;
    }
    await releaseTelegramCredential({
      heartbeat: leasedRuntime.heartbeat,
      release: () => leasedRuntime.credentialLease.release(),
    });
    leaseReleased = true;
  };
  let stateRoot: string | undefined;
  let apiProxy: Awaited<ReturnType<TelegramUserbotSkillRuntime["startApiProxy"]>> | undefined;
  let userbot: TelegramUserbotDriver | undefined;
  let participants: TelegramRuntimeParticipant[] = [];
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
  const resetRoutes = () => {
    const initialChatId = Number(directMessageOnly ? credential.sutBotId : credential.groupId);
    routes.clear();
    routes.set(routeKey(0, initialChatId), {
      id: credential.groupId,
      kind: directMessageOnly ? "direct" : "channel",
    });
  };
  const nativeMessageIds = new Map<
    string,
    { observer: number; chatId: number; messageId: number }
  >();
  const busMessages = new Map<string, { id: string; update?: TelegramUserbotUpdate }>();
  let sendsInFlight = 0;
  let deferredReplies: Array<{ update: TelegramUserbotUpdate; observer: number }> = [];
  let localMessageId = 1;

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
      update.senderId !== Number(credential.sutBotId)
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
    participants = privateProduction
      ? privateDescriptor!.participants.map((participant) => ({
          alias: participant.alias,
          mode: "hitl" as const,
          testerUserId: participant.userId,
        }))
      : [
          {
            alias: "primary",
            credential,
            mode: "userbot",
            testerUserId: credential.testerUserId,
          },
          ...(credential.participants ?? []).map((participant) => ({
            alias: participant.alias,
            credential: { ...credential, ...participant, participants: undefined },
            mode: "userbot" as const,
            testerUserId: participant.testerUserId,
          })),
        ];
    resetRoutes();
    if (!privateProduction) {
      stateRoot = skillRuntime!.createStateRoot();
      const restored = skillRuntime!.restoreCredential(
        // SAFETY: The leased credential passed the Telegram test-credential parser above.
        credential as TelegramTestCredential,
        stateRoot,
      );
      apiProxy = await skillRuntime!.startApiProxy(leaseHealth);
      await apiProxy.drainUpdates(credential.sutToken);
      userbot = await TelegramUserbotDriver.start({
        chatId: directMessageOnly ? `@${credential.sutUsername}` : restored.groupId,
        ...(credential.forumGroupId ? { observeChatIds: [credential.forumGroupId] } : {}),
        expectedUserId: credential.testerUserId,
        driverEnv: restored.driverEnv,
        leaseHealth,
        userDriverPath: skillRuntime!.userDriverPath,
        onUpdate: (update) => observeUpdate(update, 0),
      });
      drivers.push(userbot);
      for (const [offset, participant] of participants.slice(1).entries()) {
        if (!participant.credential) {
          continue;
        }
        const root = skillRuntime!.createStateRoot();
        participantRoots.push(root);
        const restoredParticipant = skillRuntime!.restoreCredential(
          // SAFETY: Userbot participants are derived from the parsed Telegram test credential.
          participant.credential as TelegramTestCredential,
          root,
        );
        drivers.push(
          await TelegramUserbotDriver.start({
            chatId: directMessageOnly ? `@${credential.sutUsername}` : restored.groupId,
            expectedUserId: participant.testerUserId,
            driverEnv: restoredParticipant.driverEnv,
            leaseHealth,
            userDriverPath: skillRuntime!.userDriverPath,
            onUpdate: (update) => observeUpdate(update, offset + 1),
          }),
        );
      }
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
      if (participantCleanupUncertain && leasedRuntime) {
        try {
          await leasedRuntime.credentialLease.heartbeat();
        } finally {
          await leasedRuntime.heartbeat.stop();
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

  if (!privateProduction && (!userbot || !apiProxy || !stateRoot)) {
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
      leasedRuntime?.heartbeat.throwIfFailed();
    },
    describeTransportState: () => describeTelegramQaObserverState(observerState),
    async sendInbound(input) {
      leasedRuntime?.heartbeat.throwIfFailed();
      let observer = participants.findIndex(
        (participant) =>
          participant.alias === input.senderId || participant.testerUserId === input.senderId,
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
      if (!participant) {
        throw new Error("Telegram QA participant is unavailable.");
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
          ? Number(credential.sutBotId)
          : Number(
              forumTopicId ? (credential.forumGroupId ?? credential.groupId) : credential.groupId,
            );
      // Shared rooms use one observer. TDLib IDs and local-app attestations share that route.
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
      const text = renderTelegramQaInboundText(input, credential.sutUsername);
      sendsInFlight += 1;
      try {
        let sent: TelegramUserbotUpdate;
        let messageObserver = observer;
        let appProofReply: string | undefined;
        if (participant.mode === "hitl") {
          const appParticipant = privateDescriptor?.participants[observer];
          if (!privateDescriptor || !appParticipant) {
            throw new Error("Telegram local-app participant is unavailable.");
          }
          if (
            input.conversation.kind === "group" &&
            (forumTopicId !== privateDescriptor.forumTopicId ||
              chatId !== Number(privateDescriptor.forumGroupId))
          ) {
            throw new Error("Telegram local-app forum send targets the wrong private topic.");
          }
          messageObserver = routeObserver;
          const proof = await requestTelegramPrivateAppTurn({
            descriptor: privateDescriptor,
            destination: input.conversation.kind === "direct" ? "bot-dm" : "forum-topic",
            participant: appParticipant,
            text,
          });
          appProofReply = proof.replyText;
          sent = {
            kind: "message",
            chatId,
            ...(forumTopicId === undefined ? {} : { forumTopicId }),
            messageId: localMessageId++,
            senderId: Number(participant.testerUserId),
            timestamp: Date.now(),
            text,
            entities: [],
          };
        } else {
          const driver = drivers[observer];
          if (!driver) {
            throw new Error("Telegram QA participant driver is unavailable.");
          }
          sent = await driver.send({
            text,
            chatId: String(chatId),
            ...(forumTopicId === undefined ? {} : { forumTopicId }),
            replyToMessageId: reply?.messageId,
          });
        }
        if (
          String(sent.senderId) !== participant.testerUserId ||
          sent.chatId !== chatId ||
          (forumTopicId !== undefined && sent.forumTopicId !== forumTopicId)
        ) {
          throw new Error(
            "Telegram send receipt does not match the configured participant and requested chat/topic.",
          );
        }
        const message = await context.messages.addInboundMessage({
          ...input,
          accountId,
          senderId: participant.testerUserId,
        });
        nativeMessageIds.set(message.id, {
          observer: messageObserver,
          chatId,
          messageId: sent.messageId,
        });
        busMessages.set(nativeKey(messageObserver, chatId, sent.messageId), { id: message.id });
        if (appProofReply !== undefined) {
          await observeUpdate(
            {
              kind: "message",
              chatId,
              ...(forumTopicId === undefined ? {} : { forumTopicId }),
              messageId: localMessageId++,
              replyToMessageId: sent.messageId,
              senderId: Number(credential.sutBotId),
              senderUsername: credential.sutUsername,
              timestamp: Date.now(),
              text: appProofReply,
              entities: [],
            },
            messageObserver,
          );
        }
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
        (participants.length < 2 || !credential.forumGroupId || !credential.forumTopicId)
      ) {
        throw new Error(
          "Telegram participant identity proof requires distinct participants, forumGroupId, and forumTopicId.",
        );
      }
      return {
        telegramIdentityFixture: {
          participantAliases: participants.map((participant) => participant.alias),
          forumTopicId: credential.forumTopicId,
        },
        readTelegramMessages: () => {
          for (const driver of drivers) {
            driver.assertHealthy();
          }
          leasedRuntime?.heartbeat.throwIfFailed();
          // Share the existing message lifetime; readers cannot mutate a later snapshot.
          return [...busMessages.values()].flatMap(({ update }) =>
            update ? [structuredClone(update)] : [],
          );
        },
      };
    },
    createGatewayConfig: () =>
      // SAFETY: The builder accepts an empty base and supplies every QA-owned config section.
      buildTelegramQaConfig({} as OpenClawConfig, {
        apiRoot: activeApiProxy?.apiRoot,
        directMessageOnly,
        enableDirectMessages: true,
        additionalTesterUserIds: participants
          .slice(1)
          .map((participant) => participant.testerUserId),
        forumGroupId: credential.forumGroupId,
        groupId: credential.groupId,
        sutToken: credential.sutToken,
        testerUserId: credential.testerUserId,
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
          ? credential.testerUserId
          : topic
            ? (credential.forumGroupId ?? credential.groupId)
            : credential.groupId;
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
    createReportNotes: () => [
      privateProduction
        ? "Runs through two operator-local Telegram.app participants; private UI attestations back the native send and reply observations."
        : "Runs through the Telegram Test Server userbot adapter.",
    ],
    async cleanup() {
      if (observerStopped) {
        return;
      }
      observerStopped = true;
      const errors: unknown[] = [];
      errors.push(...(await closeParticipants()));
      if (errors.length) {
        throw new AggregateError(
          errors,
          "Telegram participant cleanup is unconfirmed; retained private state and lease.",
        );
      }
      for (const root of [...(activeStateRoot ? [activeStateRoot] : []), ...participantRoots]) {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    async cleanupAfterGatewayStop() {
      const cleanupErrors: unknown[] = [];
      if (!apiProxyClosed && activeApiProxy) {
        try {
          await activeApiProxy.close();
          apiProxyClosed = true;
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (
        leasedRuntime &&
        (participantCleanupUncertain || (await shouldRetainQaGatewayCredentialLease()))
      ) {
        try {
          await leasedRuntime.credentialLease.heartbeat();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await leasedRuntime.heartbeat.stop();
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

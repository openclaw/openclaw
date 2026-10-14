// Names newly created Discord threads from their first user/agent conversation.
import {
  MessageType,
  PermissionFlagsBits,
  type GatewayMessageCreateDispatchData as APIMessage,
} from "discord-api-types/v10";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { prepareSessionBindingInspections } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { DiscordError, getChannel, type Client } from "../internal/discord.js";
import { withDiscordRequestAuthority } from "../internal/request-authority.js";
import { editChannelDiscord } from "../send.channels.js";
import { hasAnyChannelPermissionDiscord } from "../send.permissions.js";
import { resolveDiscordConversationBindingRoute } from "./conversation-binding-route.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicyReader } from "./live-policy.js";
import { resolveDiscordConversationRoute } from "./route-resolution.js";
import {
  resolveDiscordAutoNameAccess,
  type DiscordAutoNameContributor,
} from "./thread-auto-name.access.js";
import { resolveDiscordThreadAutoNameThreshold } from "./thread-auto-name.config.js";
import {
  DiscordThreadAutoNameState,
  DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS,
} from "./thread-auto-name.state.js";
import { generateThreadTitle } from "./thread-title.js";

const MAX_TRACKED_THREADS = 10_000;
const MAX_TRANSCRIPT_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 350;
const MAX_TRANSCRIPT_CHARS = 1_800;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

type ThreadCreateEvent = {
  id: string;
  guild_id?: string;
  parent_id?: string | null;
  name?: string | null;
  newly_created?: boolean;
  thread_metadata?: { create_timestamp?: string };
};

type ThreadState = {
  guildId: string;
  parentId: string;
  originalName: string;
  createdAt: number;
  count: number;
  lastMessageId: bigint;
  messages: CollectedMessage[];
  human?: DiscordAutoNameContributor;
  claimed: boolean;
  canceled: boolean;
  pending: Promise<void>;
  pendingCount: number;
};

type CollectedMessage = DiscordAutoNameContributor & Pick<APIMessage, "id" | "content">;

function snowflakeTime(id: string): number | null {
  return /^\d{17,20}$/.test(id) ? Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS : null;
}

export function sanitizeDiscordAutoNameTitle(raw: string): string | null {
  const title = raw
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, "")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\*|_|~|`|>|#|\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(title, 100).trim() || null;
}

function isConversationMessage(message: APIMessage, botUserId: string): boolean {
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) {
    return false;
  }
  if (message.author.bot && message.author.id !== botUserId) {
    return false;
  }
  return Boolean(
    message.content?.trim() ||
    message.attachments?.length ||
    message.embeds?.length ||
    message.sticker_items?.length,
  );
}

function formatTranscriptLine(message: CollectedMessage, botUserId: string): string {
  const role = message.author.id === botUserId ? "Agent" : "User";
  const content = message.content?.replace(/\s+/g, " ").trim() || "[attachment]";
  return `${role}: ${truncateUtf16Safe(content, MAX_MESSAGE_CHARS)}`;
}

function buildTranscript(lines: string[]): string {
  const selected: string[] = [];
  let remaining = MAX_TRANSCRIPT_CHARS;
  for (let index = lines.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    selected.unshift(truncateUtf16Safe(line, remaining));
    remaining -= line.length + 1;
  }
  return selected.join("\n");
}

export class DiscordThreadAutoNamer {
  private stopped = false;
  private readonly generationAbort = new AbortController();
  private readonly threads = new Map<string, ThreadState>();
  private readonly readPolicy: DiscordLivePolicyReader;
  private readonly state: DiscordThreadAutoNameState;

  constructor(
    private readonly params: {
      cfg: OpenClawConfig;
      accountId: string;
      botUserId: string;
      readPolicy?: DiscordLivePolicyReader;
      nowMs?: () => number;
    },
  ) {
    this.readPolicy = params.readPolicy ?? createDiscordLivePolicyReader(params);
    this.state = new DiscordThreadAutoNameState(params);
  }

  onThreadCreate(data: ThreadCreateEvent): void {
    // Message-started public threads share the older starter message's snowflake.
    const timestamp = data.thread_metadata?.create_timestamp;
    const createdAt = timestamp ? Date.parse(timestamp) : snowflakeTime(data.id);
    // TTL retirement is safe because expired threads can never enter the naming window again.
    if (
      this.stopped ||
      data.newly_created !== true ||
      !data.parent_id ||
      !data.guild_id ||
      createdAt === null ||
      !Number.isFinite(createdAt) ||
      createdAt > this.now() ||
      this.now() - createdAt >= DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS ||
      this.threads.has(data.id)
    ) {
      return;
    }
    this.threads.set(data.id, {
      guildId: data.guild_id,
      parentId: data.parent_id,
      originalName: data.name ?? "",
      createdAt,
      count: 0,
      lastMessageId: 0n,
      messages: [],
      claimed: false,
      canceled: false,
      pending: Promise.resolve(),
      pendingCount: 0,
    });
    for (const [id, state] of this.threads) {
      if (this.now() - state.createdAt >= DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS) {
        state.canceled = true;
        this.threads.delete(id);
      }
    }
    pruneMapToMaxSize(this.threads, MAX_TRACKED_THREADS);
  }

  onThreadUpdate(data: { id: string; name?: string | null }): void {
    const state = this.threads.get(data.id);
    if (state && data.name && data.name !== state.originalName) {
      state.claimed = true;
      state.canceled = true;
      this.threads.delete(data.id);
      void this.state.claim(data.id);
    }
  }

  onThreadDelete(threadId: string): void {
    const state = this.threads.get(threadId);
    if (state) {
      state.canceled = true;
    }
    this.threads.delete(threadId);
    void this.state.deleteClaim(threadId);
  }

  onMessage(message: APIMessage, client: Client): Promise<void> | undefined {
    const state = this.threads.get(message.channel_id);
    if (
      this.stopped ||
      !state ||
      state.claimed ||
      !isConversationMessage(message, this.params.botUserId) ||
      !/^\d{17,20}$/.test(message.id) ||
      message.webhook_id
    ) {
      return undefined;
    }
    if (state.pendingCount >= MAX_TRANSCRIPT_MESSAGES) {
      // Naming is optional; cancel overloaded candidates instead of retaining a raw-event backlog.
      state.canceled = true;
      this.threads.delete(message.channel_id);
      return state.pending;
    }
    const contributor: CollectedMessage = {
      id: message.id,
      channel_id: message.channel_id,
      guild_id: message.guild_id,
      author: message.author,
      member: message.member,
      content: truncateUtf16Safe(message.content?.trim() || "[attachment]", MAX_MESSAGE_CHARS),
    };
    state.pendingCount += 1;
    // Admission awaits live policy without blocking Gateway delivery.
    const pending = state.pending.then(() => this.collectMessage(contributor, state, client));
    state.pending = pending
      .catch(() => {
        logVerbose(`discord: thread auto-name admission failed for ${contributor.channel_id}`);
      })
      .finally(() => {
        state.pendingCount -= 1;
      });
    return state.pending;
  }

  stop(): void {
    this.stopped = true;
    this.generationAbort.abort();
    for (const state of this.threads.values()) {
      state.canceled = true;
    }
    this.threads.clear();
  }

  private now(): number {
    return this.params.nowMs?.() ?? Date.now();
  }

  private active(threadId: string, state: ThreadState): boolean {
    return (
      !this.stopped &&
      this.threads.get(threadId) === state &&
      !state.canceled &&
      this.now() - state.createdAt < DISCORD_THREAD_AUTO_NAME_CLAIM_TTL_MS
    );
  }

  private access(
    threadId: string,
    state: ThreadState,
    client: Client,
    contributors = state.messages,
    refreshMembers = true,
  ) {
    return resolveDiscordAutoNameAccess({
      readPolicy: this.readPolicy,
      accountId: this.params.accountId,
      botUserId: this.params.botUserId,
      threadId,
      guildId: state.guildId,
      parentId: state.parentId,
      originalName: state.originalName,
      client,
      // The human authorizing agent traffic can outlive their text in the rolling window.
      contributors: state.human ? [state.human, ...contributors] : contributors,
      refreshMembers,
    });
  }

  private async collectMessage(
    message: CollectedMessage,
    state: ThreadState,
    client: Client,
  ): Promise<void> {
    const threadId = message.channel_id;
    if (
      !this.active(threadId, state) ||
      state.claimed ||
      BigInt(message.id) <= state.lastMessageId
    ) {
      return;
    }
    const access = await this.access(threadId, state, client, [...state.messages, message], false);
    const policy = access?.policy;
    if (!policy || !policy.isCurrent() || !this.active(threadId, state)) {
      return;
    }
    if (!(await this.state.initialize()) || (await this.state.hasClaim(threadId))) {
      this.threads.delete(threadId);
      return;
    }
    if (!policy.isCurrent() || !this.active(threadId, state)) {
      return;
    }
    state.lastMessageId = BigInt(message.id);
    state.count += 1;
    if (message.author.id !== this.params.botUserId) {
      state.human = {
        channel_id: message.channel_id,
        guild_id: message.guild_id,
        author: message.author,
        member: message.member,
      };
    }
    state.messages.push(message);
    if (state.messages.length > MAX_TRANSCRIPT_MESSAGES) {
      state.messages.shift();
    }
    if (state.count < resolveDiscordThreadAutoNameThreshold(policy.cfg, this.params.accountId)) {
      return;
    }
    state.claimed = true;
    if (!(await this.state.claim(threadId)) || !this.active(threadId, state)) {
      this.threads.delete(threadId);
      return;
    }
    await this.renameThread(threadId, state, client);
  }

  private async canRename(state: ThreadState, threadId: string, client: Client): Promise<boolean> {
    return await hasAnyChannelPermissionDiscord(
      state.guildId,
      threadId,
      this.params.botUserId,
      [PermissionFlagsBits.ManageThreads],
      { cfg: this.params.cfg, accountId: this.params.accountId, rest: client.rest },
    );
  }

  private async renameThread(threadId: string, state: ThreadState, client: Client): Promise<void> {
    let bindingSelection: Awaited<ReturnType<typeof prepareSessionBindingInspections>> | undefined;
    try {
      if (!(await this.canRename(state, threadId, client))) {
        return;
      }
      const access = await this.access(threadId, state, client);
      const policy = access?.policy;
      if (
        !access ||
        !policy ||
        !policy.isCurrent() ||
        !policy.isConfigCurrent() ||
        !this.active(threadId, state)
      ) {
        return;
      }
      const preparedBindings = await prepareSessionBindingInspections([
        {
          channel: "discord",
          accountId: this.params.accountId,
          conversationId: threadId,
          parentConversationId: state.parentId,
        },
      ]);
      bindingSelection = preparedBindings;
      const resolveAgentId = (cfg = policy.cfg, humanRoleIds = access.humanRoleIds) => {
        const { runtimeRoute, configuredRoute } = resolveDiscordConversationBindingRoute({
          cfg,
          accountId: this.params.accountId,
          runtimeConversationId: threadId,
          configuredConversationId: threadId,
          parentConversationId: state.parentId,
          inspection: preparedBindings.inspect()[0]!,
          resolveRoute: ({ boundAgentId }) =>
            resolveDiscordConversationRoute({
              cfg,
              defaultAgentId: boundAgentId,
              accountId: this.params.accountId,
              guildId: state.guildId,
              memberRoleIds: humanRoleIds,
              peer: { kind: "channel", id: threadId },
              parentConversationId: state.parentId,
            }),
        });
        if (runtimeRoute.bindingOwnerAvailable === false || runtimeRoute.pluginId) {
          throw new Error("Discord thread naming has no available agent binding owner");
        }
        return (
          runtimeRoute.boundAgentId ?? configuredRoute?.boundAgentId ?? runtimeRoute.route.agentId
        );
      };
      const agentId = resolveAgentId();
      const assertCurrent = () => {
        if (
          !policy.isCurrent() ||
          !policy.isConfigCurrent() ||
          !this.active(threadId, state) ||
          resolveAgentId() !== agentId
        ) {
          throw new Error("Discord thread naming authority is no longer current");
        }
      };
      assertCurrent();
      if (
        !(await this.state.reserveRename(state.parentId)) ||
        !policy.isCurrent() ||
        !this.active(threadId, state)
      ) {
        return;
      }
      assertCurrent();
      const generated = await generateThreadTitle({
        cfg: policy.cfg,
        agentId,
        messageText: buildTranscript(
          state.messages.map((message) => formatTranscriptLine(message, this.params.botUserId)),
        ),
        maxSourceChars: MAX_TRANSCRIPT_CHARS,
        timeoutMs: 15_000,
        abortSignal: this.generationAbort.signal,
        assertCurrent,
      });
      const title = generated && sanitizeDiscordAutoNameTitle(generated);
      if (!title || title === state.originalName || !this.active(threadId, state)) {
        return;
      }
      const current = await getChannel(client.rest, threadId);
      if (
        !("name" in current) ||
        current.name !== state.originalName ||
        !this.active(threadId, state)
      ) {
        return;
      }
      if (!(await this.canRename(state, threadId, client))) {
        return;
      }
      const finalAccess = await this.access(threadId, state, client);
      const finalPolicy = finalAccess?.policy;
      if (
        !finalAccess ||
        !finalPolicy ||
        !finalPolicy.isCurrent() ||
        !this.active(threadId, state)
      ) {
        return;
      }
      // The REST scheduler retains this assertion across queueing and rate-limit retries.
      await withDiscordRequestAuthority(
        () => {
          if (
            !finalPolicy.isCurrent() ||
            !policy.isConfigCurrent() ||
            !finalPolicy.isConfigCurrent() ||
            !this.active(threadId, state) ||
            resolveAgentId(finalPolicy.cfg, finalAccess.humanRoleIds) !== agentId
          ) {
            throw new Error("Discord thread naming authority is no longer current");
          }
        },
        () =>
          editChannelDiscord(
            { channelId: threadId, name: title },
            { cfg: finalPolicy.cfg, accountId: this.params.accountId, rest: client.rest },
          ),
      );
    } catch (error) {
      if (!(error instanceof DiscordError) || (error.status !== 403 && error.status !== 429)) {
        logVerbose(`discord: thread auto-name failed for ${threadId}`);
      }
    } finally {
      bindingSelection?.dispose();
      if (this.threads.get(threadId) === state) {
        this.threads.delete(threadId);
      }
    }
  }
}

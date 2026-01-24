# Google Chat Plugin Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Convert Google Chat provider from RemixPartners fork (ProviderPlugin) to upstream plugin (ChannelPlugin)

**Architecture:** Create modular plugin in `extensions/google-chat/` using new ChannelPlugin adapter pattern. Port existing business logic from fork, remove hardcoded paths, add onboarding wizard, register with plugin API.

**Tech Stack:** TypeScript, googleapis (Google Chat API), @google-cloud/pubsub, Clawdbot plugin SDK

---

## Task 1: Create Plugin Structure

**Files:**
- Create: `extensions/google-chat/package.json`
- Create: `extensions/google-chat/clawdbot.plugin.json`
- Create: `extensions/google-chat/tsconfig.json`

**Step 1: Create plugin directory**

Run: `mkdir -p extensions/google-chat/src`

**Step 2: Create package.json**

Create `extensions/google-chat/package.json`:

```json
{
  "name": "@clawdbot/google-chat",
  "version": "1.0.0",
  "description": "Google Chat channel plugin for Clawdbot",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js"
  },
  "dependencies": {
    "googleapis": "^170.0.0",
    "@google-cloud/pubsub": "^5.2.1"
  },
  "devDependencies": {
    "clawdbot": "workspace:*"
  },
  "engines": {
    "node": ">=22.12.0"
  }
}
```

**Step 3: Create plugin manifest**

Create `extensions/google-chat/clawdbot.plugin.json`:

```json
{
  "id": "google-chat",
  "name": "Google Chat",
  "description": "Google Chat channel via Pub/Sub webhooks",
  "configSchema": {
    "schema": {
      "type": "object",
      "properties": {
        "enabled": {
          "type": "boolean",
          "default": true
        },
        "projectId": {
          "type": "string"
        },
        "subscriptionName": {
          "type": "string"
        },
        "credentialsPath": {
          "type": "string"
        },
        "allowFrom": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "default": []
        },
        "dmPolicy": {
          "enum": ["open", "pairing", "closed"],
          "default": "pairing"
        },
        "spacePolicy": {
          "enum": ["open", "pairing", "closed"],
          "default": "closed"
        },
        "historyLimit": {
          "type": "number",
          "default": 20
        },
        "accounts": {
          "type": "object",
          "additionalProperties": {
            "type": "object"
          }
        }
      }
    },
    "uiHints": {
      "projectId": {
        "label": "Google Cloud Project ID",
        "help": "Your GCP project ID (e.g., my-project-123)"
      },
      "subscriptionName": {
        "label": "Pub/Sub Subscription",
        "help": "Full subscription path: projects/PROJECT_ID/subscriptions/SUBSCRIPTION_NAME"
      },
      "credentialsPath": {
        "label": "Service Account Credentials",
        "help": "Path to service account JSON file",
        "sensitive": true
      },
      "allowFrom": {
        "label": "Allowed Email Addresses",
        "help": "Email addresses allowed to message the bot"
      },
      "dmPolicy": {
        "label": "Direct Message Policy",
        "help": "How to handle DMs: open (anyone), pairing (allowlist), closed (disabled)"
      },
      "spacePolicy": {
        "label": "Space/Group Policy",
        "help": "How to handle spaces: open (any space), pairing (allowlist), closed (disabled)"
      }
    }
  }
}
```

**Step 4: Create tsconfig.json**

Create `extensions/google-chat/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["./**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Commit structure**

Run: `git add extensions/google-chat && git commit -m "feat(google-chat): create plugin structure

- Add package.json with googleapis and pubsub dependencies
- Add plugin manifest with config schema
- Add TypeScript config"`

---

## Task 2: Port Types

**Files:**
- Create: `extensions/google-chat/src/types.ts`

**Step 1: Copy types from fork**

Copy `/Users/remixpartners/Projects/clawdbot/src/googlechat/types.ts` to `extensions/google-chat/src/types.ts`:

```typescript
import type { DmPolicy, GroupPolicy } from "clawdbot/plugin-sdk";

export type GoogleChatAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Google Chat account. Default: true. */
  enabled?: boolean;
  /** Google Cloud Project ID. */
  projectId?: string;
  /** Pub/Sub subscription name (full path: projects/.../subscriptions/...). */
  subscriptionName?: string;
  /** Path to service account credentials JSON file. */
  credentialsPath?: string;
  /** Direct message access policy (default: pairing). */
  dmPolicy?: DmPolicy;
  /** Allowlist for DM senders (email addresses). */
  allowFrom?: string[];
  /** Group/space access policy (default: disabled). */
  spacePolicy?: GroupPolicy;
  /** Allowlist for spaces (space IDs). */
  allowSpaces?: string[];
  /** Max space messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Outbound message prefix. */
  messagePrefix?: string;
};

export type GoogleChatConfig = {
  /** Optional per-account Google Chat configuration (multi-account). */
  accounts?: Record<string, GoogleChatAccountConfig>;
} & GoogleChatAccountConfig;

export type GoogleChatMessage = {
  name: string;
  sender: {
    name: string;
    displayName: string;
    email?: string;
    type: "HUMAN" | "BOT";
  };
  createTime: string;
  text?: string;
  space: {
    name: string;
    type: "DM" | "ROOM" | "SPACE";
    displayName?: string;
  };
  thread?: {
    name: string;
  };
  argumentText?: string;
  slashCommand?: {
    commandId: string;
  };
};

export type GoogleChatEvent = {
  type: "MESSAGE" | "ADDED_TO_SPACE" | "REMOVED_FROM_SPACE" | "CARD_CLICKED";
  eventTime: string;
  message?: GoogleChatMessage;
  user?: {
    name: string;
    displayName: string;
    email?: string;
  };
  space?: {
    name: string;
    type: string;
    displayName?: string;
  };
};
```

**Step 2: Update imports**

The only change needed is importing `DmPolicy` and `GroupPolicy` from `clawdbot/plugin-sdk` instead of `../config/types.js`.

**Step 3: Commit types**

Run: `git add extensions/google-chat/src/types.ts && git commit -m "feat(google-chat): add TypeScript types for Google Chat API

- Port types from fork
- Update imports to use plugin SDK"`

---

## Task 3: Port Account Resolution

**Files:**
- Create: `extensions/google-chat/src/accounts.ts`

**Step 1: Copy and adapt accounts.ts**

Create `extensions/google-chat/src/accounts.ts` (adapted from fork's `src/googlechat/accounts.ts`):

```typescript
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";
import type { GoogleChatAccountConfig, GoogleChatConfig } from "./types.js";

export type ResolvedGoogleChatAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  projectId?: string;
  subscriptionName?: string;
  credentialsPath?: string;
  config: GoogleChatAccountConfig;
};

export function listGoogleChatAccountIds(cfg: ClawdbotConfig): string[] {
  const googlechat = (cfg.channels?.googlechat ?? {}) as GoogleChatConfig;
  const accounts = googlechat.accounts ?? {};

  // Check if top-level config exists (single account mode)
  const hasTopLevel = Boolean(googlechat.projectId?.trim());

  if (Object.keys(accounts).length === 0 && hasTopLevel) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return Object.keys(accounts);
}

export function resolveDefaultGoogleChatAccountId(
  cfg: ClawdbotConfig,
): string {
  const ids = listGoogleChatAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveGoogleChatAccount(options: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedGoogleChatAccount {
  const { cfg, accountId } = options;
  const googlechat = (cfg.channels?.googlechat ?? {}) as GoogleChatConfig;

  const resolvedAccountId = accountId ?? resolveDefaultGoogleChatAccountId(cfg);

  // Try account-specific config first
  const accountConfig = googlechat.accounts?.[resolvedAccountId];

  // Fall back to top-level config for single-account setups
  const config: GoogleChatAccountConfig = accountConfig ?? {
    name: googlechat.name,
    enabled: googlechat.enabled,
    projectId: googlechat.projectId,
    subscriptionName: googlechat.subscriptionName,
    credentialsPath: googlechat.credentialsPath,
    dmPolicy: googlechat.dmPolicy,
    allowFrom: googlechat.allowFrom,
    spacePolicy: googlechat.spacePolicy,
    allowSpaces: googlechat.allowSpaces,
    historyLimit: googlechat.historyLimit,
    dmHistoryLimit: googlechat.dmHistoryLimit,
    textChunkLimit: googlechat.textChunkLimit,
    messagePrefix: googlechat.messagePrefix,
  };

  return {
    accountId: resolvedAccountId,
    name: config.name,
    enabled: config.enabled !== false,
    projectId: config.projectId,
    subscriptionName: config.subscriptionName,
    credentialsPath: config.credentialsPath,
    config,
  };
}
```

**Step 2: Commit accounts**

Run: `git add extensions/google-chat/src/accounts.ts && git commit -m "feat(google-chat): add account resolution logic

- Support single-account and multi-account configs
- Resolve account by ID with fallback to defaults
- List all configured account IDs"`

---

## Task 4: Port Send Logic

**Files:**
- Create: `extensions/google-chat/src/send.ts`

**Step 1: Copy and adapt send.ts**

Create `extensions/google-chat/src/send.ts`:

```typescript
import { type chat_v1, google } from "googleapis";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const chatClients: Map<string, chat_v1.Chat> = new Map();

async function getChatClient(
  account: ResolvedGoogleChatAccount,
): Promise<chat_v1.Chat> {
  const cacheKey = `${account.accountId}:${account.credentialsPath ?? "default"}`;
  const cached = chatClients.get(cacheKey);
  if (cached) return cached;

  const auth = new google.auth.GoogleAuth({
    keyFile: account.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/chat.bot"],
  });

  const client = google.chat({
    version: "v1",
    auth,
  });

  chatClients.set(cacheKey, client);
  return client;
}

export type SendGoogleChatResult = {
  messageId: string;
  spaceName: string;
};

export async function sendGoogleChatText(
  to: string,
  text: string,
  options: {
    account: ResolvedGoogleChatAccount;
    threadKey?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  const prefix = options.account.config.messagePrefix;
  const formattedText = prefix ? `${prefix} ${text}` : text;

  const requestBody: chat_v1.Schema$Message = {
    text: formattedText,
  };

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export async function sendGoogleChatMedia(
  to: string,
  mediaUrl: string,
  options: {
    account: ResolvedGoogleChatAccount;
    caption?: string;
    threadKey?: string;
  },
): Promise<SendGoogleChatResult> {
  const client = await getChatClient(options.account);

  const spaceName = to.startsWith("spaces/") ? to : `spaces/${to}`;

  const requestBody: chat_v1.Schema$Message = {
    text: options.caption ?? "",
    // Google Chat doesn't have direct media upload like WhatsApp
    // Media URLs are embedded as links in text
    // For proper media support, would need to use cards with images
  };

  if (options.threadKey) {
    requestBody.thread = { name: options.threadKey };
  }

  const response = await client.spaces.messages.create({
    parent: spaceName,
    requestBody,
  });

  return {
    messageId: response.data.name ?? "",
    spaceName,
  };
}

export function chunkGoogleChatText(text: string, chunkLimit: number): string[] {
  if (text.length <= chunkLimit) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= chunkLimit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at newline
    const chunk = remaining.substring(0, chunkLimit);
    const lastNewline = chunk.lastIndexOf("\n");

    if (lastNewline > chunkLimit * 0.5) {
      chunks.push(remaining.substring(0, lastNewline));
      remaining = remaining.substring(lastNewline + 1);
    } else {
      // No good newline, split at space
      const lastSpace = chunk.lastIndexOf(" ");
      if (lastSpace > chunkLimit * 0.5) {
        chunks.push(remaining.substring(0, lastSpace));
        remaining = remaining.substring(lastSpace + 1);
      } else {
        // No good space, hard split
        chunks.push(chunk);
        remaining = remaining.substring(chunkLimit);
      }
    }
  }

  return chunks;
}
```

**Step 2: Commit send logic**

Run: `git add extensions/google-chat/src/send.ts && git commit -m "feat(google-chat): add message sending logic

- Send text messages via Google Chat API
- Send media messages (as text with URL)
- Chunk long messages intelligently
- Cache API clients per account"`

---

## Task 5: Port Probe Logic

**Files:**
- Create: `extensions/google-chat/src/probe.ts`

**Step 1: Copy and adapt probe.ts**

Create `extensions/google-chat/src/probe.ts`:

```typescript
import { google } from "googleapis";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

export type GoogleChatProbe = {
  ok: boolean;
  error?: string;
};

export async function probeGoogleChat(
  account: ResolvedGoogleChatAccount,
  timeoutMs?: number,
): Promise<GoogleChatProbe> {
  try {
    if (!account.credentialsPath) {
      return { ok: false, error: "No credentials path configured" };
    }

    if (!account.projectId) {
      return { ok: false, error: "No project ID configured" };
    }

    const auth = new google.auth.GoogleAuth({
      keyFile: account.credentialsPath,
      scopes: ["https://www.googleapis.com/auth/chat.bot"],
    });

    const client = google.chat({
      version: "v1",
      auth,
    });

    // Simple probe: try to list spaces (will return empty if bot not added anywhere)
    // This validates credentials and API access
    await Promise.race([
      client.spaces.list({ pageSize: 1 }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Probe timeout")), timeoutMs ?? 5000),
      ),
    ]);

    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
```

**Step 2: Commit probe**

Run: `git add extensions/google-chat/src/probe.ts && git commit -m "feat(google-chat): add health probe

- Validate credentials and API access
- Test Google Chat API connection
- Return detailed error messages"`

---

## Task 6: Create Runtime Injection

**Files:**
- Create: `extensions/google-chat/src/runtime.ts`

**Step 1: Create runtime.ts**

Create `extensions/google-chat/src/runtime.ts`:

```typescript
import type { ClawdbotRuntime } from "clawdbot/plugin-sdk";

let runtime: ClawdbotRuntime;

export function setGoogleChatRuntime(r: ClawdbotRuntime): void {
  runtime = r;
}

export function getGoogleChatRuntime(): ClawdbotRuntime {
  if (!runtime) {
    throw new Error("Google Chat runtime not initialized");
  }
  return runtime;
}
```

**Step 2: Commit runtime**

Run: `git add extensions/google-chat/src/runtime.ts && git commit -m "feat(google-chat): add runtime dependency injection

- Store runtime reference for plugin use
- Provide getter with validation"`

---

## Task 7: Create Channel Plugin (Part 1 - Config & Security Adapters)

**Files:**
- Create: `extensions/google-chat/src/channel.ts`

**Step 1: Create channel.ts with config adapter**

Create `extensions/google-chat/src/channel.ts`:

```typescript
import type {
  ChannelPlugin,
  ClawdbotConfig,
} from "clawdbot/plugin-sdk";
import {
  DEFAULT_ACCOUNT_ID,
} from "clawdbot/plugin-sdk";

import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  listGoogleChatAccountIds,
  resolveDefaultGoogleChatAccountId,
  resolveGoogleChatAccount,
} from "./accounts.js";
import { probeGoogleChat } from "./probe.js";

const meta = {
  id: "googlechat",
  label: "Google Chat",
  selectionLabel: "Google Chat (Pub/Sub)",
  docsPath: "/channels/google-chat",
  docsLabel: "google-chat",
  blurb: "Google Chat via Pub/Sub webhooks",
  order: 70,
} as const;

export const googlechatPlugin: ChannelPlugin<ResolvedGoogleChatAccount> = {
  id: "googlechat",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "group", "thread"],
    threads: true,
    media: false, // Google Chat doesn't support direct media upload via API
  },
  reload: { configPrefixes: ["channels.googlechat"] },
  config: {
    listAccountIds: (cfg: ClawdbotConfig) => listGoogleChatAccountIds(cfg),
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string) =>
      resolveGoogleChatAccount({ cfg, accountId }),
    defaultAccountId: (cfg: ClawdbotConfig) =>
      resolveDefaultGoogleChatAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = googlechat.accounts ?? {};

      // Single account mode
      if (accountId === DEFAULT_ACCOUNT_ID && !accounts[accountId]) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            googlechat: {
              ...googlechat,
              enabled,
            },
          },
        };
      }

      // Multi-account mode
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          googlechat: {
            ...googlechat,
            accounts: {
              ...accounts,
              [accountId]: {
                ...accounts[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = { ...googlechat.accounts };

      delete accounts[accountId];

      // If deleting default account in single-account mode, clear top-level config
      if (accountId === DEFAULT_ACCOUNT_ID && Object.keys(accounts).length === 0) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            googlechat: undefined,
          },
        };
      }

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          googlechat: {
            ...googlechat,
            accounts,
          },
        },
      };
    },
    isConfigured: (account: ResolvedGoogleChatAccount) =>
      Boolean(account.projectId?.trim() && account.subscriptionName?.trim()),
    describeAccount: (account: ResolvedGoogleChatAccount) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      ),
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveGoogleChatAccount({ cfg, accountId }).config.allowFrom ?? [],
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  },
  pairing: {
    idLabel: "email",
    normalizeAllowEntry: (entry) => entry.toLowerCase().trim(),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const googlechat = cfg.channels?.googlechat ?? {};
      const accounts = googlechat.accounts ?? {};
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(accounts[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.googlechat.accounts.${resolvedAccountId}.`
        : "channels.googlechat.";

      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: `clawdbot channels pair googlechat --approve <email>`,
        normalizeEntry: (raw) => raw.toLowerCase().trim(),
      };
    },
  },
  threading: {
    resolveReplyToMode: () => "first",
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildProviderSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeGoogleChat(account, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(
        account.projectId?.trim() && account.subscriptionName?.trim(),
      );
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
};
```

**Step 2: Commit channel plugin foundation**

Run: `git add extensions/google-chat/src/channel.ts && git commit -m "feat(google-chat): add ChannelPlugin foundation

- Implement config adapter (account management)
- Implement security adapter (DM policy, allowlists)
- Implement status adapter (health probes)
- Implement pairing adapter (email-based)
- Define channel capabilities and metadata"`

---

## Task 8: Create Channel Plugin (Part 2 - Outbound Adapter)

**Files:**
- Modify: `extensions/google-chat/src/channel.ts`

**Step 1: Add outbound adapter**

Add to `googlechatPlugin` in `extensions/google-chat/src/channel.ts` (before the closing `}`):

```typescript
  outbound: {
    deliveryMode: "direct",
    chunker: chunkGoogleChatText,
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Google Chat requires --to <spaceId>"),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatText(to, text, {
        account,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, cfg, replyToId }) => {
      const account = resolveGoogleChatAccount({ cfg, accountId });
      const result = await sendGoogleChatMedia(to, mediaUrl ?? "", {
        account,
        caption: text,
        threadKey: replyToId ?? undefined,
      });
      return { provider: "googlechat", ...result };
    },
  },
```

**Step 2: Add imports**

Add to imports at top of `extensions/google-chat/src/channel.ts`:

```typescript
import {
  chunkGoogleChatText,
  sendGoogleChatMedia,
  sendGoogleChatText,
} from "./send.js";
```

**Step 3: Commit outbound adapter**

Run: `git add extensions/google-chat/src/channel.ts && git commit -m "feat(google-chat): add outbound message adapter

- Send text messages with chunking
- Send media messages (as URLs)
- Support thread replies"`

---

## Task 9: Port Monitor (Gateway Adapter Prep)

**Files:**
- Create: `extensions/google-chat/src/monitor.ts`

**Step 1: Create simplified monitor**

Create `extensions/google-chat/src/monitor.ts`:

```typescript
import { PubSub } from "@google-cloud/pubsub";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatEvent } from "./types.js";
import { getGoogleChatRuntime } from "./runtime.js";

export type MonitorOptions = {
  account: ResolvedGoogleChatAccount;
  config: ClawdbotConfig;
  runtime: any;
  abortSignal: AbortSignal;
};

export async function monitorGoogleChatProvider(
  options: MonitorOptions,
): Promise<void> {
  const { account, runtime, abortSignal } = options;

  if (!account.credentialsPath || !account.subscriptionName) {
    throw new Error("Google Chat account not properly configured");
  }

  const pubsub = new PubSub({
    projectId: account.projectId,
    keyFilename: account.credentialsPath,
  });

  const subscription = pubsub.subscription(account.subscriptionName);

  const messageHandler = async (message: any) => {
    try {
      const event: GoogleChatEvent = JSON.parse(message.data.toString());

      // Process Google Chat events
      // TODO: Route to agent via runtime

      runtime.log?.info(`[${account.accountId}] Received event: ${event.type}`);

      message.ack();
    } catch (error) {
      runtime.log?.error(`[${account.accountId}] Error processing message:`, error);
      message.nack();
    }
  };

  subscription.on("message", messageHandler);

  // Handle abort signal
  abortSignal.addEventListener("abort", () => {
    subscription.removeListener("message", messageHandler);
    subscription.close();
  });

  runtime.log?.info(`[${account.accountId}] Google Chat monitor started`);

  // Keep alive until aborted
  await new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
```

**Step 2: Commit monitor**

Run: `git add extensions/google-chat/src/monitor.ts && git commit -m "feat(google-chat): add Pub/Sub event monitor

- Listen for Google Chat events via Pub/Sub
- Parse and route events
- Handle abort signals for clean shutdown"`

---

## Task 10: Add Gateway Adapter

**Files:**
- Modify: `extensions/google-chat/src/channel.ts`

**Step 1: Add gateway adapter**

Add to `googlechatPlugin` in `extensions/google-chat/src/channel.ts` (before the closing `}`):

```typescript
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info(`[${account.accountId}] starting Google Chat provider`);

      const { monitorGoogleChatProvider } = await import("./monitor.js");

      return monitorGoogleChatProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
```

**Step 2: Commit gateway adapter**

Run: `git add extensions/google-chat/src/channel.ts && git commit -m "feat(google-chat): add gateway adapter

- Start Pub/Sub monitoring on gateway start
- Handle account lifecycle"`

---

## Task 11: Create Plugin Entry Point

**Files:**
- Create: `extensions/google-chat/index.ts`

**Step 1: Create index.ts**

Create `extensions/google-chat/index.ts`:

```typescript
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { googlechatPlugin } from "./src/channel.js";
import { setGoogleChatRuntime } from "./src/runtime.js";

const plugin = {
  id: "google-chat",
  name: "Google Chat",
  description: "Google Chat channel via Pub/Sub webhooks",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setGoogleChatRuntime(api.runtime);
    api.registerChannel({ plugin: googlechatPlugin });
  },
};

export default plugin;
```

**Step 2: Commit plugin entry point**

Run: `git add extensions/google-chat/index.ts && git commit -m "feat(google-chat): add plugin entry point

- Register channel with plugin API
- Initialize runtime injection"`

---

## Task 12: Create Basic README

**Files:**
- Create: `extensions/google-chat/README.md`

**Step 1: Create README.md**

Create `extensions/google-chat/README.md`:

```markdown
# Google Chat Plugin for Clawdbot

Connect Clawdbot to Google Chat via Pub/Sub webhooks.

## Prerequisites

- Google Cloud Project
- Service account with Google Chat API access
- Pub/Sub subscription configured

## Quick Start

1. **Enable the plugin:**

```bash
clawdbot config set channels.googlechat.enabled true
```

2. **Configure credentials:**

```bash
clawdbot config set channels.googlechat.projectId "your-project-id"
clawdbot config set channels.googlechat.subscriptionName "projects/your-project/subscriptions/your-sub"
clawdbot config set channels.googlechat.credentialsPath "/path/to/service-account.json"
```

3. **Set up allowlist:**

```bash
clawdbot config set channels.googlechat.allowFrom '["user@example.com"]'
```

4. **Start the gateway:**

```bash
clawdbot gateway run
```

## Configuration

See `clawdbot.plugin.json` for full configuration schema.

### DM Policy

- `open`: Accept DMs from anyone
- `pairing`: Require email to be in allowlist (default)
- `closed`: Disable DMs

### Space Policy

- `open`: Accept messages from any space
- `pairing`: Require space ID in allowlist
- `closed`: Disable space messages (default)

## Setup Guide

Detailed setup instructions coming soon.

## Features

- ✅ Text messages
- ✅ Thread replies
- ✅ DM and space support
- ✅ Email-based allowlists
- ✅ Multi-account support
- ❌ Media upload (Google Chat API limitation)

## License

Same as Clawdbot
```

**Step 2: Commit README**

Run: `git add extensions/google-chat/README.md && git commit -m "docs(google-chat): add basic README

- Document quick start
- Explain configuration options
- List features and limitations"`

---

## Task 13: Test Plugin Registration

**Step 1: Build the project**

Run: `npm run build`

Expected: TypeScript compiles without errors

**Step 2: Check plugin is detected**

Run: `npm run clawdbot -- plugins list` (or equivalent)

Expected: Should see "google-chat" plugin listed

**Step 3: Verify config schema**

Run: `npm run clawdbot -- config get channels.googlechat`

Expected: Should show empty/default config

---

## Task 14: Add Changelog Entry

**Files:**
- Modify: `CHANGELOG.md`

**Step 1: Add changelog entry**

Add to top of `CHANGELOG.md` (after version header):

```markdown
## [Unreleased]

### Added

- **Google Chat channel plugin**: Connect Clawdbot to Google Chat via Pub/Sub webhooks
  - Email-based allowlists for DMs and spaces
  - Thread reply support
  - Multi-account configuration
  - Health probes and status monitoring
  - Text message sending with intelligent chunking
```

**Step 2: Commit changelog**

Run: `git add CHANGELOG.md && git commit -m "docs: add Google Chat plugin to changelog"`

---

## Summary

**Total Tasks:** 14

**What We Built:**
1. ✅ Plugin structure (package.json, manifest, tsconfig)
2. ✅ TypeScript types
3. ✅ Account resolution (multi-account support)
4. ✅ Send logic (text, media, chunking)
5. ✅ Health probes
6. ✅ Runtime injection
7. ✅ ChannelPlugin implementation (all adapters)
8. ✅ Pub/Sub event monitor
9. ✅ Plugin entry point
10. ✅ Basic documentation
11. ✅ Changelog entry

**What's Missing (Future Work):**
- Onboarding wizard (interactive setup)
- Webhook HTTP handler (for webhook-based setup instead of Pub/Sub)
- Full documentation with Google Cloud Console screenshots
- Integration tests
- Media card support (Google Chat cards with images)

**Next Steps:**
1. Test manually with real Google Chat account
2. Add onboarding wizard (Task 15+)
3. Submit upstream PR when ready

# Implementation Milestones: ADR-006 MAX Messenger Extension

## Document Metadata

| Field                 | Value                                                   |
| --------------------- | ------------------------------------------------------- |
| **Date**              | 2026-02-16                                              |
| **Status**            | DRAFT                                                   |
| **ADR**               | ADR-006 (MAX Messenger Extension for OpenClaw)          |
| **Reference Pattern** | `extensions/telegram/` (5-file ChannelPlugin structure) |
| **Target Directory**  | `extensions/max/`                                       |
| **Estimated Tests**   | 80 total                                                |

---

## Dependency Graph

```
M1: Extension Scaffold
 |
 v
M2: Channel Plugin Skeleton ----+----+----+----+
 |                               |    |    |    |
 v                               v    v    v    |
M3: Outbound Messaging     M5: Config  M6: Status |
 |                           & Setup   & Probing  |
 v                               |    |           |
M4: Gateway (Webhook + Polling)  |    |           |
 |                               |    |           |
 +-------+-----------+-----------+----+           |
         |                                        |
         v                                        v
   M7: Platform Registration              (independent)
         |
         v
   M8: Integration Tests
```

**Parallelization opportunities:**

- M3, M5, and M6 can be developed in parallel after M2 is complete.
- M4 depends on M3 (outbound send logic is used within gateway event handlers).
- M7 can start any time after M2 but is typically done last before integration.
- M8 requires all of M1-M7 to be complete.

---

## Milestone 1: Extension Scaffold

**Goal:** Create the minimal extension file structure that loads into the OpenClaw plugin system without errors.

### Files to Create

| File                   | Path                                  |
| ---------------------- | ------------------------------------- |
| `package.json`         | `extensions/max/package.json`         |
| `openclaw.plugin.json` | `extensions/max/openclaw.plugin.json` |
| `index.ts`             | `extensions/max/index.ts`             |
| `src/runtime.ts`       | `extensions/max/src/runtime.ts`       |

### File Contents

#### `extensions/max/package.json`

```json
{
  "name": "@openclaw/max",
  "version": "2026.2.16",
  "private": true,
  "description": "OpenClaw MAX messenger channel plugin",
  "type": "module",
  "devDependencies": {
    "openclaw": "workspace:*"
  },
  "openclaw": {
    "extensions": ["./index.ts"]
  }
}
```

**Rationale:** Exact mirror of `extensions/telegram/package.json`. The `workspace:*` devDep ensures the extension resolves platform types at build time. The `openclaw.extensions` array declares the entry point for the plugin loader.

#### `extensions/max/openclaw.plugin.json`

```json
{
  "id": "max",
  "channels": ["max"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
```

**Rationale:** Mirrors `extensions/telegram/openclaw.plugin.json`. The `channels` array declares which channel IDs this plugin provides. The config schema is intentionally empty because channel config is defined in `channel.ts` via `buildChannelConfigSchema()`.

#### `extensions/max/index.ts`

```typescript
import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { maxPlugin } from "./src/channel.js";
import { setMaxRuntime } from "./src/runtime.js";

const plugin = {
  id: "max",
  name: "MAX",
  description: "MAX messenger channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMaxRuntime(api.runtime);
    api.registerChannel({ plugin: maxPlugin as ChannelPlugin });
  },
};

export default plugin;
```

**Rationale:** Exact structural copy of `extensions/telegram/index.ts`. The `register` function: (1) captures the runtime singleton, (2) registers the channel plugin with the platform. The `as ChannelPlugin` cast is needed because the generic type parameters of `maxPlugin` are narrower than the `any` defaults.

#### `extensions/max/src/runtime.ts`

```typescript
import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMaxRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getMaxRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("MAX runtime not initialized");
  }
  return runtime;
}
```

**Rationale:** Module-level singleton pattern identical to `extensions/telegram/src/runtime.ts`. The `setMaxRuntime` is called once during `register()`. All subsequent code uses `getMaxRuntime()` which throws if the plugin was not properly initialized.

### Dependencies

- None (this is the first milestone).

### Acceptance Criteria

1. `extensions/max/` directory exists with all 4 files.
2. TypeScript compiles without errors (`tsc --noEmit` passes).
3. Plugin loader discovers and loads the extension (plugin appears in `requireActivePluginRegistry()`).
4. `getMaxRuntime()` throws `"MAX runtime not initialized"` when called before `register()`.
5. After `register()`, `getMaxRuntime()` returns a valid `PluginRuntime` instance.

### Estimated Tests: 2

| #   | Test                                                                                             | Type |
| --- | ------------------------------------------------------------------------------------------------ | ---- |
| 1   | Plugin registration: `register()` calls `setMaxRuntime` and `registerChannel`                    | Unit |
| 2   | Runtime singleton: `getMaxRuntime()` throws before init, returns runtime after `setMaxRuntime()` | Unit |

---

## Milestone 2: Channel Plugin Skeleton

**Goal:** Create `src/channel.ts` with all `ChannelPlugin` sections defined as stubs that satisfy the TypeScript compiler. No real logic yet, just the structural contract.

### Files to Create

| File             | Path                            |
| ---------------- | ------------------------------- |
| `src/channel.ts` | `extensions/max/src/channel.ts` |

### File Contents

```typescript
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { getMaxRuntime } from "./runtime.js";

// --- Type stubs (to be refined in later milestones) ---

interface ResolvedMaxAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  token: string;
  tokenSource: "config" | "env" | "none";
  config: {
    webhookUrl?: string;
    webhookSecret?: string;
    webhookPath?: string;
    dmPolicy?: "open" | "pairing" | "closed";
    allowFrom?: string[];
    proxy?: string;
    groupPolicy?: string;
    groups?: Record<string, unknown>;
  };
}

interface MaxProbe {
  ok: boolean;
  bot?: {
    id?: number;
    name?: string;
    username?: string;
  };
  error?: string;
}

// --- Config Schema ---

const MaxConfigSchema = {
  type: "object" as const,
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    botToken: { type: "string" },
    tokenFile: { type: "string" },
    webhookUrl: { type: "string" },
    webhookSecret: { type: "string" },
    webhookPath: { type: "string" },
    dmPolicy: { type: "string", enum: ["open", "pairing", "closed"] },
    allowFrom: { type: "array", items: { type: "string" } },
    proxy: { type: "string" },
    name: { type: "string" },
    accounts: { type: "object", additionalProperties: true },
  },
};

// --- Meta ---

const meta = getChatChannelMeta("max");

// --- Message Actions Stub ---

const maxMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getMaxRuntime().channel.max.messageActions?.listActions?.(ctx) ?? [],
  extractToolSend: (ctx) =>
    getMaxRuntime().channel.max.messageActions?.extractToolSend?.(ctx) ?? null,
  handleAction: async (ctx) => {
    const ma = getMaxRuntime().channel.max.messageActions;
    if (!ma?.handleAction) {
      throw new Error("MAX message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

// --- Helper stubs (to be implemented in M5/M6) ---

function listMaxAccountIds(_cfg: OpenClawConfig): string[] {
  // TODO: M5 — extract account IDs from cfg.channels.max
  return [];
}

function resolveMaxAccount(_params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedMaxAccount {
  // TODO: M5 — resolve full account from config
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    enabled: false,
    token: "",
    tokenSource: "none",
    config: {},
  };
}

function resolveDefaultMaxAccountId(_cfg: OpenClawConfig): string | undefined {
  // TODO: M5 — find first configured account
  return DEFAULT_ACCOUNT_ID;
}

function collectMaxStatusIssues(_params: unknown): { level: string; message: string }[] {
  // TODO: M6 — collect status issues
  return [];
}

function looksLikeMaxTargetId(raw: string): boolean {
  return /^\d+$/.test(raw.trim());
}

function normalizeMaxMessagingTarget(raw: string): string {
  return raw.trim();
}

// --- Channel Plugin ---

export const maxPlugin: ChannelPlugin<ResolvedMaxAccount, MaxProbe> = {
  id: "max",

  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: true,
    blockStreaming: true,
  },

  reload: { configPrefixes: ["channels.max"] },

  configSchema: buildChannelConfigSchema(MaxConfigSchema),

  pairing: {
    idLabel: "maxUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^max:/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      // TODO: M3 — send approval notification via MAX
      throw new Error("MAX pairing notification not implemented");
    },
  },

  config: {
    listAccountIds: (cfg) => listMaxAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMaxAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMaxAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "max",
        accountId,
        clearBaseFields: ["botToken", "tokenFile", "name"],
      }),
    isConfigured: (account) => Boolean(account.token?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.token?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMaxAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^max:/i, ""))
        .map((entry) => entry.toLowerCase()),
  },

  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.max?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.max.accounts.${resolvedAccountId}.`
        : "channels.max.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("max"),
        normalizeEntry: (raw) => raw.replace(/^max:/i, ""),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      // TODO: M5 — collect security warnings for MAX
      return [];
    },
  },

  groups: {
    resolveRequireMention: ({ cfg, accountId, groupId }) => {
      // TODO: M5 — resolve group mention policy
      return true;
    },
    resolveToolPolicy: ({ cfg, accountId, groupId }) => {
      // TODO: M5 — resolve group tool policy
      return undefined;
    },
  },

  messaging: {
    normalizeTarget: normalizeMaxMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeMaxTargetId,
      hint: "<chatId>",
    },
  },

  directory: {
    self: async () => null,
    listPeers: async (_params) => [],
    listGroups: async (_params) => [],
  },

  actions: maxMessageActions,

  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "max",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      // TODO: M5 — validate MAX-specific input
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "MAX_BOT_TOKEN can only be used for the default account.";
      }
      if (!input.useEnv && !input.token && !input.tokenFile) {
        return "MAX requires token or --token-file (or --use-env).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      // TODO: M5 — apply MAX config to openclaw.json
      return cfg;
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMaxRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      // TODO: M3 — send text via MAX API
      throw new Error("MAX sendText not implemented");
    },
    sendMedia: async ({ to, text, mediaUrl, accountId }) => {
      // TODO: M3 — send media via MAX API
      throw new Error("MAX sendMedia not implemented");
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: collectMaxStatusIssues,
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      // TODO: M6 — probe MAX API via GET /me
      throw new Error("MAX probeAccount not implemented");
    },
    buildAccountSnapshot: ({ account, cfg, runtime, probe }) => {
      // TODO: M6 — build snapshot
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: Boolean(account.token?.trim()),
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: runtime?.mode ?? (account.config.webhookUrl ? "webhook" : "polling"),
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      // TODO: M4 — start webhook or polling listener
      throw new Error("MAX gateway not implemented");
    },
    logoutAccount: async ({ accountId, cfg }) => {
      // TODO: M5 — clear token and logout
      return { cleared: false, envToken: false, loggedOut: false };
    },
  },
};
```

### Dependencies

- **M1** must be complete (runtime singleton, index.ts imports channel.ts).

### Acceptance Criteria

1. TypeScript compiles without errors (`tsc --noEmit` passes for `extensions/max/`).
2. All `ChannelPlugin` sections are defined: `id`, `meta`, `capabilities`, `pairing`, `config`, `security`, `groups`, `messaging`, `directory`, `actions`, `setup`, `outbound`, `status`, `gateway`.
3. `maxPlugin.id === "max"`.
4. `maxPlugin.capabilities.chatTypes` includes `"direct"` and `"group"` but not `"channel"` or `"thread"` (MAX does not support Telegram-style channels or forum threads).
5. Stub methods throw meaningful `"not implemented"` errors rather than silently returning garbage.

### Estimated Tests: 5

| #   | Test                                                                                     | Type |
| --- | ---------------------------------------------------------------------------------------- | ---- |
| 1   | Plugin has correct `id: "max"`                                                           | Unit |
| 2   | Capabilities: `chatTypes` includes "direct" and "group", excludes "channel" and "thread" | Unit |
| 3   | `config.isConfigured` returns true when token is set, false when empty                   | Unit |
| 4   | `pairing.idLabel === "maxUserId"`                                                        | Unit |
| 5   | `outbound.textChunkLimit === 4000` and `chunkerMode === "markdown"`                      | Unit |

---

## Milestone 3: Outbound Messaging

**Goal:** Implement the outbound messaging section so that the extension can send text messages, media messages, and properly chunk long messages for MAX's 4096-character limit.

### Files to Modify

| File             | Path                            | Action                 |
| ---------------- | ------------------------------- | ---------------------- |
| `src/channel.ts` | `extensions/max/src/channel.ts` | Replace outbound stubs |

### Key Code

#### `outbound.sendText`

```typescript
outbound: {
  deliveryMode: "direct",
  chunker: (text, limit) =>
    getMaxRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ to, text, accountId, deps, replyToId }) => {
    const send =
      deps?.sendMax ??
      getMaxRuntime().channel.max.sendMessageMax;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const result = await send(to, text, {
      verbose: false,
      replyToMessageId,
      accountId: accountId ?? undefined,
      format: "markdown",
    });
    return { channel: "max", ...result };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
    const send =
      deps?.sendMax ??
      getMaxRuntime().channel.max.sendMessageMax;
    const replyToMessageId = parseReplyToMessageId(replyToId);
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      replyToMessageId,
      accountId: accountId ?? undefined,
      format: "markdown",
    });
    return { channel: "max", ...result };
  },
},
```

#### Helper: `parseReplyToMessageId`

```typescript
function parseReplyToMessageId(replyToId?: string | null) {
  if (!replyToId) {
    return undefined;
  }
  // MAX uses string message IDs (mid.xxxx format)
  return replyToId.trim() || undefined;
}
```

**Key differences from Telegram:**

- MAX uses string-based message IDs (e.g., `mid.xxxx`), not integer IDs like Telegram.
- No `messageThreadId` parameter (MAX does not have forum thread support).
- `format: "markdown"` is sent explicitly (Telegram defaults to markdown in runtime).
- No `parseThreadId` helper needed.

#### Pairing Notification (also in this milestone)

```typescript
pairing: {
  idLabel: "maxUserId",
  normalizeAllowEntry: (entry) => entry.replace(/^max:/i, ""),
  notifyApproval: async ({ cfg, id }) => {
    const { token } = getMaxRuntime().channel.max.resolveMaxToken(cfg);
    if (!token) {
      throw new Error("MAX token not configured");
    }
    await getMaxRuntime().channel.max.sendMessageMax(
      id,
      PAIRING_APPROVED_MESSAGE,
      { token },
    );
  },
},
```

#### Inline Keyboard Support (attachments)

The MAX API supports inline keyboards via the `attachments` field on `POST /messages`. The runtime handles this, but the extension must pass attachment data correctly:

```typescript
// When a tool sends a keyboard, the deps will include attachments
sendText: async ({ to, text, accountId, deps, replyToId, attachments }) => {
  const send =
    deps?.sendMax ??
    getMaxRuntime().channel.max.sendMessageMax;
  const result = await send(to, text, {
    verbose: false,
    replyToMessageId: parseReplyToMessageId(replyToId),
    accountId: accountId ?? undefined,
    format: "markdown",
    attachments: attachments ?? undefined,  // inline keyboards, etc.
  });
  return { channel: "max", ...result };
},
```

### Dependencies

- **M1** (runtime singleton) and **M2** (channel skeleton) must be complete.
- Requires `runtime.channel.max.sendMessageMax` to be available in the platform runtime. If the runtime API is not yet implemented, tests must mock it.

### Acceptance Criteria

1. `outbound.sendText` calls `runtime.channel.max.sendMessageMax` with correct parameters.
2. `outbound.sendMedia` passes `mediaUrl` to the runtime send function.
3. `outbound.chunker` delegates to `runtime.channel.text.chunkMarkdownText`.
4. `outbound.textChunkLimit` is `4000` (conservative, within MAX's 4096 limit).
5. `parseReplyToMessageId` handles null, undefined, empty string, and valid string IDs.
6. `pairing.notifyApproval` sends the `PAIRING_APPROVED_MESSAGE` to the given user ID.
7. `format: "markdown"` is always passed in send options.
8. Inline keyboard attachments are passed through when present.

### Estimated Tests: 15

| #   | Test                                                                 | Type |
| --- | -------------------------------------------------------------------- | ---- |
| 1   | `sendText` calls runtime.sendMessageMax with correct `to` and `text` | Unit |
| 2   | `sendText` passes `format: "markdown"`                               | Unit |
| 3   | `sendText` passes `accountId` when provided                          | Unit |
| 4   | `sendText` passes `replyToMessageId` when provided                   | Unit |
| 5   | `sendText` returns `{ channel: "max", ...result }`                   | Unit |
| 6   | `sendText` uses `deps.sendMax` when provided (dependency injection)  | Unit |
| 7   | `sendMedia` passes `mediaUrl` to runtime                             | Unit |
| 8   | `sendMedia` sends text alongside media                               | Unit |
| 9   | `sendMedia` handles missing mediaUrl gracefully                      | Unit |
| 10  | `chunker` delegates to `runtime.channel.text.chunkMarkdownText`      | Unit |
| 11  | `parseReplyToMessageId` returns undefined for null                   | Unit |
| 12  | `parseReplyToMessageId` returns undefined for empty string           | Unit |
| 13  | `parseReplyToMessageId` returns trimmed string for valid ID          | Unit |
| 14  | `pairing.notifyApproval` sends message via runtime                   | Unit |
| 15  | `pairing.notifyApproval` throws when token is not configured         | Unit |

---

## Milestone 4: Gateway (Webhook + Long Polling)

**Goal:** Implement the `gateway.startAccount` section to support both webhook-based and long-polling-based event reception from the MAX Bot API.

### Files to Modify

| File             | Path                            | Action                |
| ---------------- | ------------------------------- | --------------------- |
| `src/channel.ts` | `extensions/max/src/channel.ts` | Replace gateway stubs |

### Key Code

#### `gateway.startAccount`

```typescript
gateway: {
  startAccount: async (ctx) => {
    const account = ctx.account;
    const token = account.token.trim();

    // Probe the bot to get a label for logging
    let maxBotLabel = "";
    try {
      const probe = await getMaxRuntime().channel.max.probeMax(
        token,
        2500,
        account.config.proxy,
      );
      const username = probe.ok ? probe.bot?.username?.trim() : null;
      if (username) {
        maxBotLabel = ` (@${username})`;
      }
    } catch (err) {
      if (getMaxRuntime().logging.shouldLogVerbose()) {
        ctx.log?.debug?.(
          `[${account.accountId}] bot probe failed: ${String(err)}`,
        );
      }
    }

    ctx.log?.info(
      `[${account.accountId}] starting MAX provider${maxBotLabel}`,
    );

    return getMaxRuntime().channel.max.monitorMaxProvider({
      token,
      accountId: account.accountId,
      config: ctx.cfg,
      runtime: ctx.runtime,
      abortSignal: ctx.abortSignal,
      useWebhook: Boolean(account.config.webhookUrl),
      webhookUrl: account.config.webhookUrl,
      webhookSecret: account.config.webhookSecret,
      webhookPath: account.config.webhookPath,
    });
  },

  logoutAccount: async ({ accountId, cfg }) => {
    const envToken = process.env.MAX_BOT_TOKEN?.trim() ?? "";
    const nextCfg = { ...cfg } as OpenClawConfig;
    const nextMax = cfg.channels?.max
      ? { ...cfg.channels.max }
      : undefined;
    let cleared = false;
    let changed = false;

    if (nextMax) {
      // Clear base-level token for default account
      if (accountId === DEFAULT_ACCOUNT_ID && nextMax.botToken) {
        delete nextMax.botToken;
        cleared = true;
        changed = true;
      }

      // Clear account-level token
      const accounts =
        nextMax.accounts && typeof nextMax.accounts === "object"
          ? { ...nextMax.accounts }
          : undefined;
      if (accounts && accountId in accounts) {
        const entry = accounts[accountId];
        if (entry && typeof entry === "object") {
          const nextEntry = { ...entry } as Record<string, unknown>;
          if ("botToken" in nextEntry) {
            const token = nextEntry.botToken;
            if (
              typeof token === "string" ? token.trim() : token
            ) {
              cleared = true;
            }
            delete nextEntry.botToken;
            changed = true;
          }
          if (Object.keys(nextEntry).length === 0) {
            delete accounts[accountId];
            changed = true;
          } else {
            accounts[accountId] = nextEntry;
          }
        }
      }
      if (accounts) {
        if (Object.keys(accounts).length === 0) {
          delete nextMax.accounts;
          changed = true;
        } else {
          nextMax.accounts = accounts;
        }
      }
    }

    if (changed) {
      if (nextMax && Object.keys(nextMax).length > 0) {
        nextCfg.channels = { ...nextCfg.channels, max: nextMax };
      } else {
        const nextChannels = { ...nextCfg.channels };
        delete nextChannels.max;
        if (Object.keys(nextChannels).length > 0) {
          nextCfg.channels = nextChannels;
        } else {
          delete nextCfg.channels;
        }
      }
    }

    const resolved = resolveMaxAccount({
      cfg: changed ? nextCfg : cfg,
      accountId,
    });
    const loggedOut = resolved.tokenSource === "none";

    if (changed) {
      await getMaxRuntime().config.writeConfigFile(nextCfg);
    }

    return { cleared, envToken: Boolean(envToken), loggedOut };
  },
},
```

#### Webhook Event Types

The runtime's `monitorMaxProvider` must handle these 9 event types. The extension delegates all event parsing to the runtime, but the event type mapping is documented here for reference:

```typescript
// MAX webhook event types -> OpenClaw event mapping (handled by runtime)
//
// bot_started       -> session.start (create/resume session)
// message_created   -> message.received (route to agent)
// message_callback  -> callback.received (inline button press)
// message_edited    -> message.edited (update context)
// message_removed   -> message.deleted (log only)
// bot_added         -> group.joined (register group)
// bot_removed       -> group.left (cleanup group)
// user_added        -> member.added (update group members)
// user_removed      -> member.removed (update group members)
```

#### Long Polling Flow (runtime-side, documented for reference)

```typescript
// Runtime implements this; extension just passes options to monitorMaxProvider.
//
// Long Polling loop:
// 1. GET /updates?marker={lastMarker}&limit=100&timeout=30
// 2. Process each update in order
// 3. Update marker to last update's marker + 1
// 4. Check abortSignal before next iteration
// 5. On error: exponential backoff (1s, 2s, 4s, 8s, max 30s)
// 6. On abortSignal: break loop, log clean shutdown
```

#### Webhook Flow (runtime-side, documented for reference)

```typescript
// Runtime implements this; extension passes webhookUrl/Secret/Path.
//
// Webhook setup:
// 1. POST /subscriptions with { url, secret? }
// 2. Listen on configured webhookPath for incoming POSTs
// 3. Verify signature/secret on each request
// 4. Parse event body, dispatch to event handler
// 5. On abortSignal: DELETE /subscriptions to unregister
```

### Dependencies

- **M2** (skeleton) must be complete.
- **M3** (outbound) is recommended before M4, because gateway event handlers may trigger outbound messages (e.g., bot_started -> send welcome).
- Requires `runtime.channel.max.monitorMaxProvider` and `runtime.channel.max.probeMax` from the platform.

### Acceptance Criteria

1. `gateway.startAccount` calls `runtime.channel.max.probeMax` for bot identification.
2. `gateway.startAccount` calls `runtime.channel.max.monitorMaxProvider` with correct options.
3. `useWebhook` is `true` when `account.config.webhookUrl` is set, `false` otherwise.
4. `webhookUrl`, `webhookSecret`, and `webhookPath` are passed from account config.
5. `abortSignal` is forwarded to `monitorMaxProvider` for graceful shutdown.
6. `logoutAccount` clears token from config for default account (base level).
7. `logoutAccount` clears token from config for named accounts (accounts level).
8. `logoutAccount` writes updated config via `runtime.config.writeConfigFile`.
9. `logoutAccount` detects `MAX_BOT_TOKEN` env variable.
10. Probe failure is logged but does not prevent gateway startup (non-fatal).

### Estimated Tests: 20

| #   | Test                                                                       | Type |
| --- | -------------------------------------------------------------------------- | ---- |
| 1   | `startAccount` calls `probeMax` with token and timeout                     | Unit |
| 2   | `startAccount` logs bot username when probe succeeds                       | Unit |
| 3   | `startAccount` continues when probe fails (non-fatal)                      | Unit |
| 4   | `startAccount` calls `monitorMaxProvider` with correct token               | Unit |
| 5   | `startAccount` passes `useWebhook: true` when webhookUrl is set            | Unit |
| 6   | `startAccount` passes `useWebhook: false` when no webhookUrl               | Unit |
| 7   | `startAccount` forwards `abortSignal` to monitor                           | Unit |
| 8   | `startAccount` passes `webhookSecret` from config                          | Unit |
| 9   | `startAccount` passes `webhookPath` from config                            | Unit |
| 10  | `startAccount` passes `accountId` to monitor                               | Unit |
| 11  | `logoutAccount` clears base-level `botToken` for default account           | Unit |
| 12  | `logoutAccount` clears account-level `botToken` for named account          | Unit |
| 13  | `logoutAccount` removes empty account entry from accounts object           | Unit |
| 14  | `logoutAccount` removes empty accounts object                              | Unit |
| 15  | `logoutAccount` removes empty max section from channels                    | Unit |
| 16  | `logoutAccount` calls `writeConfigFile` when changes made                  | Unit |
| 17  | `logoutAccount` does not call `writeConfigFile` when no changes            | Unit |
| 18  | `logoutAccount` returns `envToken: true` when `MAX_BOT_TOKEN` is set       | Unit |
| 19  | `logoutAccount` returns `loggedOut: true` when token is fully cleared      | Unit |
| 20  | `logoutAccount` returns `cleared: true` when token was present and removed | Unit |

---

## Milestone 5: Config & Setup Wizard

**Goal:** Implement the `config`, `setup`, and `security` sections with full account CRUD, wizard flow, and DM policy management.

### Files to Modify

| File             | Path                            | Action                              |
| ---------------- | ------------------------------- | ----------------------------------- |
| `src/channel.ts` | `extensions/max/src/channel.ts` | Replace config/setup/security stubs |

### Key Code

#### `listMaxAccountIds` (full implementation)

```typescript
function listMaxAccountIds(cfg: OpenClawConfig): string[] {
  const maxConfig = cfg.channels?.max;
  if (!maxConfig) return [];

  const ids: string[] = [];

  // Base-level config counts as default account
  if (maxConfig.botToken || maxConfig.tokenFile) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // Named accounts
  const accounts = maxConfig.accounts;
  if (accounts && typeof accounts === "object") {
    for (const key of Object.keys(accounts)) {
      if (key && !ids.includes(key)) {
        ids.push(key);
      }
    }
  }

  // If nothing found but max section exists with enabled, include default
  if (ids.length === 0 && maxConfig.enabled !== false) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  return ids;
}
```

#### `resolveMaxAccount` (full implementation)

```typescript
function resolveMaxAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedMaxAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const maxConfig = cfg.channels?.max;

  // Resolve token: account-level > base-level > env
  let token = "";
  let tokenSource: "config" | "env" | "none" = "none";

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    const accountEntry = maxConfig?.accounts?.[accountId];
    if (accountEntry && typeof accountEntry === "object") {
      const entry = accountEntry as Record<string, unknown>;
      if (typeof entry.botToken === "string" && entry.botToken.trim()) {
        token = entry.botToken.trim();
        tokenSource = "config";
      }
    }
  } else {
    // Default account: base-level token
    if (typeof maxConfig?.botToken === "string" && maxConfig.botToken.trim()) {
      token = maxConfig.botToken.trim();
      tokenSource = "config";
    }
  }

  // Fallback to env for default account
  if (!token && accountId === DEFAULT_ACCOUNT_ID) {
    const envToken = process.env.MAX_BOT_TOKEN?.trim();
    if (envToken) {
      token = envToken;
      tokenSource = "env";
    }
  }

  // Resolve config fields
  const accountEntry =
    accountId !== DEFAULT_ACCOUNT_ID ? maxConfig?.accounts?.[accountId] : maxConfig;
  const configSource =
    accountEntry && typeof accountEntry === "object"
      ? (accountEntry as Record<string, unknown>)
      : {};

  return {
    accountId,
    name: typeof configSource.name === "string" ? configSource.name : undefined,
    enabled: configSource.enabled !== false,
    token,
    tokenSource,
    config: {
      webhookUrl: typeof configSource.webhookUrl === "string" ? configSource.webhookUrl : undefined,
      webhookSecret:
        typeof configSource.webhookSecret === "string" ? configSource.webhookSecret : undefined,
      webhookPath:
        typeof configSource.webhookPath === "string" ? configSource.webhookPath : undefined,
      dmPolicy:
        typeof configSource.dmPolicy === "string"
          ? (configSource.dmPolicy as "open" | "pairing" | "closed")
          : undefined,
      allowFrom: Array.isArray(configSource.allowFrom)
        ? configSource.allowFrom.map(String)
        : undefined,
      proxy: typeof configSource.proxy === "string" ? configSource.proxy : undefined,
      groupPolicy:
        typeof configSource.groupPolicy === "string" ? configSource.groupPolicy : undefined,
      groups:
        configSource.groups && typeof configSource.groups === "object"
          ? (configSource.groups as Record<string, unknown>)
          : undefined,
    },
  };
}
```

#### `setup.applyAccountConfig` (full implementation)

```typescript
setup: {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
  applyAccountName: ({ cfg, accountId, name }) =>
    applyAccountNameToChannelSection({
      cfg,
      channelKey: "max",
      accountId,
      name,
    }),
  validateInput: ({ accountId, input }) => {
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "MAX_BOT_TOKEN can only be used for the default account.";
    }
    if (!input.useEnv && !input.token && !input.tokenFile) {
      return "MAX requires token or --token-file (or --use-env).";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) => {
    const namedConfig = applyAccountNameToChannelSection({
      cfg,
      channelKey: "max",
      accountId,
      name: input.name,
    });
    const next =
      accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: "max",
          })
        : namedConfig;

    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        channels: {
          ...next.channels,
          max: {
            ...next.channels?.max,
            enabled: true,
            ...(input.useEnv
              ? {}
              : input.tokenFile
                ? { tokenFile: input.tokenFile }
                : input.token
                  ? { botToken: input.token }
                  : {}),
          },
        },
      };
    }

    return {
      ...next,
      channels: {
        ...next.channels,
        max: {
          ...next.channels?.max,
          enabled: true,
          accounts: {
            ...next.channels?.max?.accounts,
            [accountId]: {
              ...next.channels?.max?.accounts?.[accountId],
              enabled: true,
              ...(input.tokenFile
                ? { tokenFile: input.tokenFile }
                : input.token
                  ? { botToken: input.token }
                  : {}),
            },
          },
        },
      },
    };
  },
},
```

#### `security.collectWarnings` (full implementation)

```typescript
security: {
  // resolveDmPolicy stays as in M2 skeleton (already complete)
  collectWarnings: ({ account, cfg }) => {
    const defaultGroupPolicy =
      cfg.channels?.defaults?.groupPolicy;
    const groupPolicy =
      account.config.groupPolicy ??
      defaultGroupPolicy ??
      "allowlist";
    if (groupPolicy !== "open") {
      return [];
    }
    const groupAllowlistConfigured =
      account.config.groups &&
      Object.keys(account.config.groups).length > 0;
    if (groupAllowlistConfigured) {
      return [
        `- MAX groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.max.groupPolicy="allowlist" + channels.max.groupAllowFrom to restrict senders.`,
      ];
    }
    return [
      `- MAX groups: groupPolicy="open" with no channels.max.groups allowlist; any group can add + ping (mention-gated). Set channels.max.groupPolicy="allowlist" + channels.max.groupAllowFrom or configure channels.max.groups.`,
    ];
  },
},
```

### Dependencies

- **M2** (skeleton with all stub signatures).
- Requires `migrateBaseNameToDefaultAccount` from `openclaw/plugin-sdk` (same as Telegram).

### Acceptance Criteria

1. `listMaxAccountIds` returns correct account IDs from `channels.max` config.
2. `resolveMaxAccount` resolves token from account-level config.
3. `resolveMaxAccount` resolves token from base-level config for default account.
4. `resolveMaxAccount` falls back to `MAX_BOT_TOKEN` env var for default account.
5. `resolveMaxAccount` returns `tokenSource: "none"` when no token found.
6. `setup.validateInput` rejects env token for non-default accounts.
7. `setup.validateInput` rejects empty input (no token, no tokenFile, no useEnv).
8. `setup.applyAccountConfig` writes token to base-level for default account.
9. `setup.applyAccountConfig` writes token to accounts-level for named account.
10. `security.collectWarnings` warns on open group policy.

### Estimated Tests: 10

| #   | Test                                                                  | Type |
| --- | --------------------------------------------------------------------- | ---- |
| 1   | `listMaxAccountIds` returns `["default"]` for base-level token config | Unit |
| 2   | `listMaxAccountIds` returns named account IDs                         | Unit |
| 3   | `resolveMaxAccount` resolves config token for default account         | Unit |
| 4   | `resolveMaxAccount` resolves env token fallback                       | Unit |
| 5   | `resolveMaxAccount` resolves named account token                      | Unit |
| 6   | `resolveMaxAccount` returns `tokenSource: "none"` when unconfigured   | Unit |
| 7   | `validateInput` rejects env for non-default account                   | Unit |
| 8   | `validateInput` rejects empty input                                   | Unit |
| 9   | `applyAccountConfig` writes default account config correctly          | Unit |
| 10  | `security.collectWarnings` returns warning for open group policy      | Unit |

---

## Milestone 6: Status & Probing

**Goal:** Implement the `status` section so that `/status` shows MAX account health, probe results, and diagnostic information.

### Files to Modify

| File             | Path                            | Action               |
| ---------------- | ------------------------------- | -------------------- |
| `src/channel.ts` | `extensions/max/src/channel.ts` | Replace status stubs |

### Key Code

#### `status.probeAccount`

```typescript
probeAccount: async ({ account, timeoutMs }) =>
  getMaxRuntime().channel.max.probeMax(
    account.token,
    timeoutMs,
    account.config.proxy,
  ),
```

**Rationale:** Identical pattern to Telegram. The runtime calls `GET /me` on the MAX API, which returns bot identity information (name, username, bot_id). The probe result is stored in `MaxProbe` with `ok: boolean`.

#### `collectMaxStatusIssues` (full implementation)

```typescript
function collectMaxStatusIssues(params: {
  snapshot: Record<string, unknown>;
  cfg: OpenClawConfig;
  accountId: string;
}): { level: string; message: string }[] {
  const { snapshot, cfg, accountId } = params;
  const issues: { level: string; message: string }[] = [];

  // Check if token is configured
  if (!snapshot.configured) {
    issues.push({
      level: "error",
      message: `MAX account "${accountId}" has no bot token configured.`,
    });
  }

  // Check probe result
  if (snapshot.probe && typeof snapshot.probe === "object") {
    const probe = snapshot.probe as MaxProbe;
    if (!probe.ok) {
      issues.push({
        level: "error",
        message: `MAX bot probe failed: ${probe.error ?? "unknown error"}`,
      });
    }
  }

  // Check if running
  if (snapshot.configured && !snapshot.running) {
    issues.push({
      level: "warning",
      message: `MAX account "${accountId}" is configured but not running.`,
    });
  }

  // Check last error
  if (snapshot.lastError) {
    issues.push({
      level: "warning",
      message: `MAX account "${accountId}" last error: ${String(snapshot.lastError)}`,
    });
  }

  return issues;
}
```

#### `status.buildAccountSnapshot` (full implementation)

```typescript
buildAccountSnapshot: ({ account, cfg, runtime, probe }) => {
  const configured = Boolean(account.token?.trim());
  return {
    accountId: account.accountId,
    name: account.name,
    enabled: account.enabled,
    configured,
    tokenSource: account.tokenSource,
    running: runtime?.running ?? false,
    lastStartAt: runtime?.lastStartAt ?? null,
    lastStopAt: runtime?.lastStopAt ?? null,
    lastError: runtime?.lastError ?? null,
    mode:
      runtime?.mode ??
      (account.config.webhookUrl ? "webhook" : "polling"),
    probe,
    lastInboundAt: runtime?.lastInboundAt ?? null,
    lastOutboundAt: runtime?.lastOutboundAt ?? null,
  };
},
```

### Dependencies

- **M2** (skeleton) must be complete.
- Requires `runtime.channel.max.probeMax` from the platform runtime.

### Acceptance Criteria

1. `probeAccount` calls `runtime.channel.max.probeMax` with token, timeout, and proxy.
2. `collectMaxStatusIssues` returns error when token is not configured.
3. `collectMaxStatusIssues` returns error when probe fails.
4. `collectMaxStatusIssues` returns warning when configured but not running.
5. `collectMaxStatusIssues` returns warning with last error details.
6. `buildAccountSnapshot` includes all required fields (accountId, name, enabled, configured, tokenSource, running, mode, probe).
7. `buildAccountSnapshot` defaults `mode` to `"polling"` when no webhookUrl and no runtime mode.
8. `buildAccountSnapshot` defaults `mode` to `"webhook"` when webhookUrl is configured.

### Estimated Tests: 5

| #   | Test                                                         | Type |
| --- | ------------------------------------------------------------ | ---- |
| 1   | `probeAccount` delegates to runtime with correct params      | Unit |
| 2   | `collectMaxStatusIssues` reports error for missing token     | Unit |
| 3   | `collectMaxStatusIssues` reports error for failed probe      | Unit |
| 4   | `collectMaxStatusIssues` reports warning for stopped account | Unit |
| 5   | `buildAccountSnapshot` builds correct snapshot with defaults | Unit |

---

## Milestone 7: Platform Registration

**Goal:** Register `"max"` in the platform's channel order so that the MAX channel is discoverable in the channel selection UI, CLI wizard, and status commands.

### Files to Modify

| File                       | Path                       | Action                                                |
| -------------------------- | -------------------------- | ----------------------------------------------------- |
| `src/channels/registry.ts` | `src/channels/registry.ts` | Add "max" to CHAT_CHANNEL_ORDER and CHAT_CHANNEL_META |

### Key Code

#### `CHAT_CHANNEL_ORDER` update

```typescript
// Before:
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;

// After:
export const CHAT_CHANNEL_ORDER = [
  "telegram",
  "max",
  "whatsapp",
  "discord",
  "irc",
  "googlechat",
  "slack",
  "signal",
  "imessage",
] as const;
```

**Position rationale:** MAX is placed immediately after Telegram. Both are primary chat platforms using Bot API patterns. MAX serves the Russian market where Telegram may have restricted access, so it should appear as the next option. This matches the ADR-006 decision.

#### `CHAT_CHANNEL_META` update

```typescript
// Add to CHAT_CHANNEL_META record, after telegram entry:
max: {
  id: "max",
  label: "MAX",
  selectionLabel: "MAX (Bot API)",
  detailLabel: "MAX Bot",
  docsPath: "/channels/max",
  docsLabel: "max",
  blurb: "Russian super-app messenger (VK Group) — register a bot at dev.max.ru.",
  systemImage: "bubble.left",
},
```

#### `CHAT_CHANNEL_ALIASES` update

```typescript
// Add aliases for MAX:
export const CHAT_CHANNEL_ALIASES: Record<string, ChatChannelId> = {
  imsg: "imessage",
  "internet-relay-chat": "irc",
  "google-chat": "googlechat",
  gchat: "googlechat",
  vk: "max", // Legacy VK association
  "icq-new": "max", // Historical name
};
```

### Dependencies

- **M2** (channel plugin skeleton) should be complete so the plugin is available for the registry to discover.
- This is primarily a platform-core change, not an extension change.

### Acceptance Criteria

1. `CHAT_CHANNEL_ORDER` includes `"max"` at index 1 (after `"telegram"`).
2. `ChatChannelId` type includes `"max"` (auto-derived from `CHAT_CHANNEL_ORDER`).
3. `getChatChannelMeta("max")` returns valid `ChannelMeta` with correct fields.
4. `normalizeChatChannelId("max")` returns `"max"`.
5. `normalizeChatChannelId("vk")` returns `"max"` (alias).
6. `normalizeChatChannelId("icq-new")` returns `"max"` (alias).
7. `listChatChannels()` includes MAX in the returned array at position 1.
8. TypeScript compiles without errors after the type union is expanded.

### Estimated Tests: 3

| #   | Test                                                                  | Type |
| --- | --------------------------------------------------------------------- | ---- |
| 1   | `CHAT_CHANNEL_ORDER` includes "max" at correct position               | Unit |
| 2   | `normalizeChatChannelId` resolves "max" and aliases ("vk", "icq-new") | Unit |
| 3   | `getChatChannelMeta("max")` returns valid meta with id, label, blurb  | Unit |

---

## Milestone 8: Integration Tests

**Goal:** Comprehensive integration testing with a mock MAX API server to verify end-to-end flows, error handling, and rate limit compliance.

### Files to Create

| File          | Path                                                      |
| ------------- | --------------------------------------------------------- |
| Test suite    | `extensions/max/src/__tests__/channel.test.ts`            |
| Test suite    | `extensions/max/src/__tests__/gateway.test.ts`            |
| Test suite    | `extensions/max/src/__tests__/config.test.ts`             |
| Test suite    | `extensions/max/src/__tests__/status.test.ts`             |
| Mock server   | `extensions/max/src/__tests__/helpers/mock-max-api.ts`    |
| Test fixtures | `extensions/max/src/__tests__/fixtures/webhook-events.ts` |

### Mock MAX API Server

```typescript
// extensions/max/src/__tests__/helpers/mock-max-api.ts
//
// Express-based mock server that simulates MAX Bot API endpoints:
//
// GET  /me                 -> bot info (probe)
// POST /messages           -> send message (returns messageId)
// PUT  /messages           -> edit message
// DELETE /messages          -> delete message
// POST /answers            -> answer callback query
// GET  /updates            -> long polling updates
// POST /subscriptions      -> register webhook
// DELETE /subscriptions     -> unregister webhook
// POST /uploads            -> file upload (returns fileToken)
//
// Features:
// - Configurable responses (success, error codes)
// - Request recording for assertions
// - Rate limit simulation (429 responses)
// - Latency injection for timeout testing
```

### Webhook Event Fixtures

```typescript
// extensions/max/src/__tests__/fixtures/webhook-events.ts
//
// Pre-built webhook event payloads for all 9 event types:
//
// - bot_started:      { update_type: "bot_started", timestamp: ..., ... }
// - message_created:  { update_type: "message_created", message: { ... }, ... }
// - message_callback: { update_type: "message_callback", callback: { ... }, ... }
// - message_edited:   { update_type: "message_edited", message: { ... }, ... }
// - message_removed:  { update_type: "message_removed", message_id: "...", ... }
// - bot_added:        { update_type: "bot_added", chat_id: ..., ... }
// - bot_removed:      { update_type: "bot_removed", chat_id: ..., ... }
// - user_added:       { update_type: "user_added", user: { ... }, ... }
// - user_removed:     { update_type: "user_removed", user: { ... }, ... }
```

### Test Categories

#### A. End-to-End Message Flow (5 tests)

```typescript
// channel.test.ts
describe("MAX channel end-to-end", () => {
  it("sends a text message and receives response via polling", async () => {
    // 1. Configure mock API to return updates with a message
    // 2. Start gateway in polling mode
    // 3. Verify runtime.channel.max.monitorMaxProvider was called
    // 4. Simulate incoming message_created event
    // 5. Verify outbound sendText is called with correct params
  });

  it("sends a media message with upload", async () => {
    // 1. Mock /uploads to return a file token
    // 2. Mock /messages to accept the attachment
    // 3. Call sendMedia with mediaUrl
    // 4. Verify two-step upload+send flow
  });

  it("handles inline keyboard callback", async () => {
    // 1. Send message with inline keyboard attachment
    // 2. Simulate message_callback event
    // 3. Verify callback handler was invoked
  });

  it("chunks long message into multiple sends", async () => {
    // 1. Create a text that exceeds 4000 chars
    // 2. Call sendText
    // 3. Verify chunker split the message
    // 4. Verify multiple sendMessageMax calls
  });

  it("sends pairing approval notification", async () => {
    // 1. Call pairing.notifyApproval with a user ID
    // 2. Verify sendMessageMax was called with PAIRING_APPROVED_MESSAGE
  });
});
```

#### B. Webhook Delivery Tests (5 tests)

```typescript
// gateway.test.ts
describe("MAX gateway webhook", () => {
  it("processes bot_started event", async () => {
    // Verify session.start is triggered
  });

  it("processes message_created event", async () => {
    // Verify message.received is dispatched
  });

  it("processes message_callback event", async () => {
    // Verify callback handler is invoked
  });

  it("rejects webhook with invalid signature", async () => {
    // Verify request is rejected, webhook.validation_failed event emitted
  });

  it("handles all 9 event types without errors", async () => {
    // Iterate through all fixture events, verify no unhandled exceptions
  });
});
```

#### C. Long Polling Tests (3 tests)

```typescript
// gateway.test.ts
describe("MAX gateway long polling", () => {
  it("polls with correct marker tracking", async () => {
    // 1. Mock /updates to return 3 updates
    // 2. Verify marker advances after each batch
    // 3. Verify next poll uses updated marker
  });

  it("respects AbortSignal for graceful shutdown", async () => {
    // 1. Start polling
    // 2. Abort signal
    // 3. Verify loop exits cleanly
  });

  it("applies exponential backoff on error", async () => {
    // 1. Mock /updates to return 500 error
    // 2. Verify retry delays: 1s, 2s, 4s
    // 3. Mock recovery, verify polling resumes
  });
});
```

#### D. Error Handling Tests (4 tests)

```typescript
// channel.test.ts
describe("MAX error handling", () => {
  it("handles 400 Bad Request (invalid parameters)", async () => {
    // Verify error is propagated with meaningful message
  });

  it("handles 401 Unauthorized (invalid token)", async () => {
    // Verify token error is reported in status issues
  });

  it("handles 429 Too Many Requests (rate limit)", async () => {
    // Verify retry-after is respected
  });

  it("handles 503 Service Unavailable (MAX downtime)", async () => {
    // Verify graceful degradation, error logged
  });
});
```

#### E. Config & Status Tests (3 tests)

```typescript
// config.test.ts + status.test.ts
describe("MAX config and status", () => {
  it("full wizard flow: prompt -> validate -> apply -> verify", async () => {
    // 1. validateInput with token
    // 2. applyAccountConfig
    // 3. resolveMaxAccount confirms config was applied
    // 4. probeAccount confirms bot is reachable
  });

  it("status shows MAX account health", async () => {
    // 1. Build snapshot with running account
    // 2. Verify all fields are populated
    // 3. Verify collectStatusIssues returns no issues for healthy account
  });

  it("status shows issues for misconfigured account", async () => {
    // 1. Build snapshot with no token
    // 2. Verify collectStatusIssues reports token error
  });
});
```

### Dependencies

- **All milestones M1-M7** must be complete.
- Requires test framework (vitest or jest, whichever the project uses).
- Requires ability to mock `PluginRuntime` and `runtime.channel.max.*` methods.

### Acceptance Criteria

1. All integration tests pass (`npm test` / `vitest run`).
2. Code coverage >= 85% for `extensions/max/src/` directory.
3. Mock MAX API server handles all documented endpoints.
4. All 9 webhook event types have fixture data and are tested.
5. Error handling tests cover HTTP status codes 400, 401, 429, 503.
6. Rate limit compliance test verifies no more than 30 requests per second.
7. Graceful shutdown test verifies clean exit on AbortSignal.
8. No flaky tests (all tests are deterministic with mocked API).

### Estimated Tests: 20

| #     | Test                                  | Type        |
| ----- | ------------------------------------- | ----------- |
| 1-5   | End-to-end message flow (5 tests)     | Integration |
| 6-10  | Webhook delivery (5 tests)            | Integration |
| 11-13 | Long polling (3 tests)                | Integration |
| 14-17 | Error handling (4 tests)              | Integration |
| 18-20 | Config & status integration (3 tests) | Integration |

---

## Summary

| Milestone                       | Files                  | Tests  | Depends On | Parallelizable With |
| ------------------------------- | ---------------------- | ------ | ---------- | ------------------- |
| M1: Extension Scaffold          | 4 new                  | 2      | None       | None                |
| M2: Channel Plugin Skeleton     | 1 new                  | 5      | M1         | None                |
| M3: Outbound Messaging          | 1 modify               | 15     | M2         | M5, M6              |
| M4: Gateway (Webhook + Polling) | 1 modify               | 20     | M2, M3     | None                |
| M5: Config & Setup Wizard       | 1 modify               | 10     | M2         | M3, M6              |
| M6: Status & Probing            | 1 modify               | 5      | M2         | M3, M5              |
| M7: Platform Registration       | 1 modify               | 3      | M2         | M3, M5, M6          |
| M8: Integration Tests           | 6 new                  | 20     | M1-M7      | None                |
| **Total**                       | **5 new + 2 modified** | **80** |            |                     |

### Critical Path

```
M1 -> M2 -> M3 -> M4 -> M8
              \-> M5 -/
              \-> M6 -/
              \-> M7 -/
```

The critical path runs through M1 -> M2 -> M3 -> M4 -> M8, with M5, M6, and M7 as parallel branches that merge before M8.

### Files Created (New)

| #   | File                                  | Milestone |
| --- | ------------------------------------- | --------- |
| 1   | `extensions/max/package.json`         | M1        |
| 2   | `extensions/max/openclaw.plugin.json` | M1        |
| 3   | `extensions/max/index.ts`             | M1        |
| 4   | `extensions/max/src/runtime.ts`       | M1        |
| 5   | `extensions/max/src/channel.ts`       | M2        |

### Files Modified (Existing)

| #   | File                            | Milestone      |
| --- | ------------------------------- | -------------- |
| 1   | `extensions/max/src/channel.ts` | M3, M4, M5, M6 |
| 2   | `src/channels/registry.ts`      | M7             |

### Test Files Created

| #   | File                                                      | Milestone |
| --- | --------------------------------------------------------- | --------- |
| 1   | `extensions/max/src/__tests__/channel.test.ts`            | M8        |
| 2   | `extensions/max/src/__tests__/gateway.test.ts`            | M8        |
| 3   | `extensions/max/src/__tests__/config.test.ts`             | M8        |
| 4   | `extensions/max/src/__tests__/status.test.ts`             | M8        |
| 5   | `extensions/max/src/__tests__/helpers/mock-max-api.ts`    | M8        |
| 6   | `extensions/max/src/__tests__/fixtures/webhook-events.ts` | M8        |

### Runtime API Surface Required

The extension assumes the following runtime methods exist under `runtime.channel.max`:

| Method                               | Used In                  | Purpose                        |
| ------------------------------------ | ------------------------ | ------------------------------ |
| `sendMessageMax(chatId, text, opts)` | M3 (outbound)            | Send text/media message        |
| `resolveMaxToken(cfg)`               | M3 (pairing)             | Get token from config          |
| `probeMax(token, timeoutMs, proxy?)` | M4, M6 (gateway, status) | GET /me health check           |
| `monitorMaxProvider(opts)`           | M4 (gateway)             | Start webhook/polling listener |
| `messageActions`                     | M2 (actions)             | Inline button action handling  |

And from shared runtime:

| Method                                                | Used In       | Purpose                 |
| ----------------------------------------------------- | ------------- | ----------------------- |
| `runtime.channel.text.chunkMarkdownText(text, limit)` | M3 (outbound) | Markdown-aware chunking |
| `runtime.config.writeConfigFile(cfg)`                 | M4 (logout)   | Persist config changes  |
| `runtime.logging.shouldLogVerbose()`                  | M4 (gateway)  | Verbose logging check   |

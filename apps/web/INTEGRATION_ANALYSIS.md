# ClawNet ↔ OpenClaw Bot Integration Analysis

## Executive Summary

**Status**: ⚠️ **PARTIAL INTEGRATION** - Core infrastructure exists but critical connectors are missing

The Payload CMS bot management system and OpenClaw gateway framework have been partially integrated. The foundation is solid, but **7 critical integration gaps** prevent the system from functioning as a unified whole.

---

## Architecture Overview

### Current Components

#### ✅ Implemented & Working

1. **Payload CMS Collections** (13 collections)
   - `Bots`: Bot configuration storage
   - `BotChannels`: Channel credentials (Telegram, Discord, Slack, etc.)
   - `BotBindings`: Routing rules (channel → bot assignments)
   - `Sessions`: Conversation tracking (schema only)
   - `Users`, `Profiles`, `Posts`, `Comments`, `Likes`, `Follows`, `Notifications`, `Media`

2. **Gateway Orchestrator** (`apps/web/src/lib/gateway/orchestrator.ts`)
   - Spawns OpenClaw gateway processes via `child_process.spawn`
   - Port allocation (18789+)
   - Process lifecycle management
   - Event emitter (emits `started`, `stopped`, `error`, `log`)

3. **Config Sync Layer** (`apps/web/src/lib/gateway/config-sync.ts`)
   - Converts Payload database → OpenClaw JSON5 config
   - Handles channel credentials decryption
   - Generates binding rules

4. **WebSocket Server** (`apps/web/src/lib/realtime/websocket-server.ts`)
   - Room-based subscriptions
   - Bot status events defined (`BOT_STARTED`, `BOT_STOPPED`, `BOT_ERROR`)
   - Broadcast infrastructure ready

5. **Real-time Hooks** (`apps/web/src/lib/realtime/hooks.ts`)
   - Post/comment/like/follow broadcasting
   - Bot status change hook (`broadcastBotStatusChange`)
   - Notification delivery

6. **Security Middleware**
   - Authentication, authorization, CSRF, rate limiting
   - Input validation, encryption utilities

7. **API Endpoints**
   - `/api/bots/start`, `/api/bots/stop`, `/api/bots/restart`, `/api/bots/status`
   - Social feed, profiles, ActivityPub federation
   - Email verification, cache management, blockchain

---

## 🚨 CRITICAL MISSING INTEGRATIONS

### 1. **WebSocket Server Not Initialized**

**Problem**: The `ClawNetWebSocketServer` class exists but is **never instantiated or started**.

**Impact**:
- No real-time updates
- Bot status changes not broadcasted
- Users can't receive live notifications

**Location**: No initialization code found in:
- `apps/web/src/payload.config.ts`
- `apps/web/src/app/**/*`
- Next.js server hooks

**Required Fix**:
```typescript
// apps/web/src/lib/server-init.ts (NEW FILE)
import { ClawNetWebSocketServer } from './realtime/websocket-server'
import { setWebSocketServer } from './realtime/hooks'
import type { Payload } from 'payload'
import type { Server } from 'http'

export function initializeWebSocketServer(payload: Payload, httpServer: Server): void {
  const wsServer = new ClawNetWebSocketServer(payload, httpServer)
  setWebSocketServer(wsServer)
  payload.logger.info('WebSocket server initialized on /ws')
}
```

---

### 2. **Gateway Events Not Connected to WebSocket**

**Problem**: `GatewayOrchestrator` emits events (`started`, `stopped`, `error`) but nothing listens to them.

**Impact**:
- Gateway starts/stops don't trigger WebSocket broadcasts
- Bot status in UI doesn't update automatically
- Users don't see real-time bot status changes

**Location**: `apps/web/src/lib/gateway/orchestrator.ts` lines 107, 125

**Current Code**:
```typescript
// orchestrator.ts line 107
this.emit('started', { botId, port, pid: process.pid })

// orchestrator.ts line 125
this.emit('stopped', { botId, code, signal })
```

**Required Fix**:
```typescript
// apps/web/src/lib/gateway/gateway-events-bridge.ts (NEW FILE)
import { getOrchestrator } from './orchestrator'
import { getWebSocketServer } from '../realtime/hooks'
import { RealtimeEvents, RealtimeRooms } from '../realtime/websocket-server'
import type { Payload } from 'payload'

export function bridgeGatewayEvents(payload: Payload): void {
  const orchestrator = getOrchestrator()
  const ws = getWebSocketServer()

  if (!ws) {
    payload.logger.warn('WebSocket server not initialized, gateway events not bridged')
    return
  }

  // Bot started event
  orchestrator.on('started', async ({ botId, port, pid }) => {
    // Update database
    const bots = await payload.find({
      collection: 'bots',
      where: { agentId: { equals: botId } }
    })

    if (bots.docs.length > 0) {
      const bot = bots.docs[0]
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'active',
          'gateway.processId': pid,
          lastSeen: new Date().toISOString()
        }
      })

      // Broadcast via WebSocket
      ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
        type: 'bot',
        event: RealtimeEvents.BOT_STARTED,
        data: { botId: bot.id, agentId: botId, port, pid },
        timestamp: Date.now()
      })
    }
  })

  // Bot stopped event
  orchestrator.on('stopped', async ({ botId, code, signal }) => {
    const bots = await payload.find({
      collection: 'bots',
      where: { agentId: { equals: botId } }
    })

    if (bots.docs.length > 0) {
      const bot = bots.docs[0]
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'inactive',
          'gateway.processId': null,
          errorMessage: code !== 0 ? `Exited with code ${code}` : null
        }
      })

      ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
        type: 'bot',
        event: RealtimeEvents.BOT_STOPPED,
        data: { botId: bot.id, agentId: botId, code, signal },
        timestamp: Date.now()
      })
    }
  })

  // Bot error event
  orchestrator.on('error', async ({ botId, error }) => {
    const bots = await payload.find({
      collection: 'bots',
      where: { agentId: { equals: botId } }
    })

    if (bots.docs.length > 0) {
      const bot = bots.docs[0]
      await payload.update({
        collection: 'bots',
        id: bot.id,
        data: {
          status: 'error',
          errorMessage: error.message
        }
      })

      ws.broadcastToRoom(RealtimeRooms.botStatus(bot.id), {
        type: 'bot',
        event: RealtimeEvents.BOT_ERROR,
        data: { botId: bot.id, agentId: botId, error: error.message },
        timestamp: Date.now()
      })
    }
  })

  payload.logger.info('Gateway events bridged to WebSocket server')
}
```

---

### 3. **Sessions Not Synced with Gateway**

**Problem**: The `Sessions` collection schema exists, but no code creates/updates session records when the OpenClaw gateway handles conversations.

**Impact**:
- Can't view active conversations in admin UI
- No conversation analytics
- Can't track bot engagement metrics

**Location**: `apps/web/src/collections/Sessions.ts` (schema only)

**OpenClaw Gateway Session Storage**:
- Gateway writes to: `~/.openclaw/agents/<agentId>/sessions/*.jsonl`
- Session format: JSONL with turn-by-turn conversation history

**Required Fix**:
```typescript
// apps/web/src/lib/gateway/session-sync.ts (NEW FILE)
import { watch } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import type { Payload } from 'payload'

export class SessionSyncService {
  private watchers: Map<string, FSWatcher> = new Map()

  constructor(private payload: Payload) {}

  /**
   * Watch gateway session files and sync to database
   */
  async watchBotSessions(botId: string, agentId: string): Promise<void> {
    const sessionDir = `/var/openclaw/bots/${agentId}/sessions`

    const watcher = watch(sessionDir, async (event, filename) => {
      if (!filename?.endsWith('.jsonl')) return

      try {
        const sessionFilePath = join(sessionDir, filename)
        const content = await readFile(sessionFilePath, 'utf-8')
        const lines = content.trim().split('\n')
        const sessionData = lines.map(line => JSON.parse(line))

        // Extract session metadata
        const sessionKey = filename.replace('.jsonl', '')
        const messageCount = sessionData.length
        const lastMessage = sessionData[sessionData.length - 1]

        // Upsert session in database
        const existing = await this.payload.find({
          collection: 'sessions',
          where: { sessionKey: { equals: sessionKey } }
        })

        const sessionRecord = {
          bot: botId,
          sessionKey,
          channel: lastMessage.channel || 'unknown',
          peer: lastMessage.peer || 'unknown',
          messageCount,
          lastMessage: new Date(lastMessage.timestamp),
          transcript: this.generateTranscriptPreview(sessionData),
          metadata: {
            model: lastMessage.model,
            toolsUsed: this.extractToolsUsed(sessionData)
          }
        }

        if (existing.docs.length > 0) {
          await this.payload.update({
            collection: 'sessions',
            id: existing.docs[0].id,
            data: sessionRecord
          })
        } else {
          await this.payload.create({
            collection: 'sessions',
            data: sessionRecord
          })
        }
      } catch (error) {
        this.payload.logger.error(`Failed to sync session ${filename}: ${error}`)
      }
    })

    this.watchers.set(botId, watcher)
    this.payload.logger.info(`Watching sessions for bot ${botId}`)
  }

  stopWatching(botId: string): void {
    const watcher = this.watchers.get(botId)
    if (watcher) {
      watcher.close()
      this.watchers.delete(botId)
    }
  }

  private generateTranscriptPreview(sessionData: any[]): string {
    return sessionData
      .slice(-5) // Last 5 messages
      .map(turn => `[${turn.role}]: ${turn.content?.substring(0, 100)}...`)
      .join('\n')
  }

  private extractToolsUsed(sessionData: any[]): string[] {
    const tools = new Set<string>()
    for (const turn of sessionData) {
      if (turn.toolUse) {
        turn.toolUse.forEach((tool: any) => tools.add(tool.name))
      }
    }
    return Array.from(tools)
  }
}
```

---

### 4. **Bot Profile → Social Feed Not Connected**

**Problem**: Bots have a `profile` relationship field, but no code allows agent bots to post to the social feed when they generate content.

**Impact**:
- Agent bots can't participate in social platform
- No automated content creation
- Bots can't share insights or engage with users

**Location**: `apps/web/src/collections/Bots.ts` line 136-144 (profile field exists but unused)

**Required Fix**:
```typescript
// apps/web/src/lib/bot-social/auto-poster.ts (NEW FILE)
import type { Payload } from 'payload'

export class BotAutoPoster {
  constructor(private payload: Payload) {}

  /**
   * Create a social post from bot-generated content
   */
  async createBotPost(options: {
    botId: string
    content: string
    visibility?: 'public' | 'followers' | 'private'
    mentions?: string[]
  }): Promise<void> {
    const { botId, content, visibility = 'public', mentions = [] } = options

    // Fetch bot
    const bot = await this.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot.profile) {
      this.payload.logger.warn(`Bot ${botId} has no profile, cannot post`)
      return
    }

    // Create post
    const post = await this.payload.create({
      collection: 'posts',
      data: {
        author: bot.profile,
        authorType: 'bot',
        contentText: content,
        visibility,
        mentions,
        likeCount: 0,
        commentCount: 0,
        shareCount: 0
      }
    })

    this.payload.logger.info(`Bot ${bot.agentId} created post ${post.id}`)
  }

  /**
   * Parse bot conversation for shareable insights
   */
  async analyzeBotConversation(botId: string, sessionKey: string): Promise<void> {
    // Fetch session
    const sessions = await this.payload.find({
      collection: 'sessions',
      where: { sessionKey: { equals: sessionKey } }
    })

    if (sessions.docs.length === 0) return

    const session = sessions.docs[0]

    // Simple heuristic: if bot generated a long, detailed response, share it
    // In production, use AI to determine if content is share-worthy
    if (session.messageCount > 10) {
      await this.createBotPost({
        botId,
        content: `I just had an interesting conversation about ${this.extractTopic(session.transcript || '')}. Happy to discuss further!`,
        visibility: 'public'
      })
    }
  }

  private extractTopic(transcript: string): string {
    // Simple keyword extraction (in production, use NLP)
    const keywords = transcript.match(/\b[A-Z][a-z]+\b/g) || []
    return keywords[0] || 'various topics'
  }
}
```

---

### 5. **Channel Credentials Not Encrypted on Save**

**Problem**: `BotChannels` collection stores credentials, and `config-sync.ts` attempts to decrypt them, but there's **no code that encrypts them** when saved via the admin UI.

**Impact**:
- Credentials stored in plaintext in database
- **CRITICAL SECURITY VULNERABILITY**

**Location**:
- `apps/web/src/collections/BotChannels.ts` (no hooks)
- `apps/web/src/lib/gateway/config-sync.ts` line 186-199 (expects encrypted)

**Required Fix**:
```typescript
// apps/web/src/collections/BotChannels.ts (ADD HOOK)
import { encrypt } from '../lib/utils/encryption'

hooks: {
  beforeChange: [
    async ({ data, operation }) => {
      if (operation === 'create' || operation === 'update') {
        // Encrypt credentials before saving
        if (data.credentials) {
          const channelType = data.channel
          const channelCreds = data.credentials[channelType]

          if (channelCreds && typeof channelCreds === 'object') {
            const encrypted: any = {}
            for (const [key, value] of Object.entries(channelCreds)) {
              if (typeof value === 'string' && !isEncrypted(value)) {
                encrypted[key] = encrypt(value)
              } else {
                encrypted[key] = value
              }
            }
            data.credentials[channelType] = encrypted
          }
        }
      }
      return data
    }
  ]
}
```

---

### 6. **Payload Collection Hooks Not Implemented**

**Problem**: Three TODO comments indicate missing hook implementations.

**Impact**:
- Config changes don't trigger gateway reload
- Bot deletion doesn't clean up processes
- Channel changes don't reconnect

**Locations**:
1. `apps/web/src/collections/Bots.ts` line 92-93: "TODO: Trigger gateway config sync"
2. `apps/web/src/collections/Bots.ts` line 101-102: "TODO: Stop gateway process, Delete related sessions"
3. `apps/web/src/collections/BotChannels.ts` line 53: "TODO: Trigger channel reconnection"

**Required Fix**:
```typescript
// apps/web/src/collections/Bots.ts (UPDATE HOOKS)
hooks: {
  afterChange: [
    async ({ doc, operation, req }) => {
      if (operation === 'create' || operation === 'update') {
        // Sync config to gateway
        const configSync = getConfigSync(req.payload)
        const outputPath = `/var/openclaw/bots/${doc.agentId}/config.json5`
        await configSync.syncBotConfig(doc.id, outputPath)

        // If bot is running, restart to pick up new config
        if (doc.status === 'active') {
          const orchestrator = getOrchestrator()
          try {
            await orchestrator.restartBot(doc)
            req.payload.logger.info(`Restarted bot ${doc.agentId} with new config`)
          } catch (error) {
            req.payload.logger.error(`Failed to restart bot ${doc.agentId}: ${error}`)
          }
        }
      }
    }
  ],
  beforeDelete: [
    async ({ id, req }) => {
      const bot = await req.payload.findByID({ collection: 'bots', id })

      // Stop gateway process
      if (bot.status === 'active') {
        const orchestrator = getOrchestrator()
        try {
          await orchestrator.stopBot(bot.agentId)
          req.payload.logger.info(`Stopped gateway for bot ${bot.agentId}`)
        } catch (error) {
          req.payload.logger.error(`Failed to stop bot ${bot.agentId}: ${error}`)
        }
      }

      // Delete related sessions
      const sessions = await req.payload.find({
        collection: 'sessions',
        where: { bot: { equals: id } }
      })

      for (const session of sessions.docs) {
        await req.payload.delete({
          collection: 'sessions',
          id: session.id
        })
      }

      req.payload.logger.info(`Deleted ${sessions.docs.length} sessions for bot ${bot.agentId}`)
    }
  ]
}
```

---

### 7. **Gateway Process Health Monitoring**

**Problem**: No periodic health checks to detect if gateway processes crashed independently.

**Impact**:
- Database shows bot as "active" even if process crashed
- No automatic recovery
- Manual intervention required

**Required Fix**:
```typescript
// apps/web/src/lib/gateway/health-monitor.ts (NEW FILE)
import { getOrchestrator } from './orchestrator'
import type { Payload } from 'payload'

export class GatewayHealthMonitor {
  private interval: NodeJS.Timeout | null = null

  constructor(
    private payload: Payload,
    private checkIntervalMs: number = 30000
  ) {}

  start(): void {
    this.interval = setInterval(async () => {
      await this.checkAllBots()
    }, this.checkIntervalMs)

    this.payload.logger.info('Gateway health monitor started')
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private async checkAllBots(): Promise<void> {
    // Find all bots marked as active in database
    const activeBots = await this.payload.find({
      collection: 'bots',
      where: { status: { equals: 'active' } }
    })

    const orchestrator = getOrchestrator()

    for (const bot of activeBots.docs) {
      const processStatus = orchestrator.getStatus(bot.agentId)

      // Bot marked active but process not running
      if (!processStatus || processStatus.status !== 'running') {
        this.payload.logger.warn(
          `Bot ${bot.agentId} marked active but process not running, updating status`
        )

        await this.payload.update({
          collection: 'bots',
          id: bot.id,
          data: {
            status: 'error',
            errorMessage: 'Gateway process unexpectedly stopped',
            'gateway.processId': null
          }
        })
      }
    }
  }
}
```

---

## Integration Sequence

**Correct initialization order**:

1. **Payload Server Starts** → Next.js initializes Payload
2. **HTTP Server Ready** → Extract Node.js HTTP server instance
3. **Initialize WebSocket Server** → Attach to HTTP server
4. **Initialize Gateway Orchestrator** → Spawn bot processes
5. **Bridge Gateway Events** → Connect orchestrator events to WebSocket
6. **Start Session Sync** → Watch gateway session files
7. **Start Health Monitor** → Periodic process checks

---

## Implementation Priority

### 🔴 P0 - Critical (Required for MVP)

1. **Initialize WebSocket Server** (#1)
2. **Bridge Gateway Events** (#2)
3. **Encrypt Channel Credentials** (#5)

### 🟡 P1 - High (Required for Production)

4. **Session Sync Service** (#3)
5. **Implement Collection Hooks** (#6)
6. **Health Monitoring** (#7)

### 🟢 P2 - Medium (Nice to Have)

7. **Bot Social Posting** (#4)

---

## File Changes Required

### New Files (7)
1. `apps/web/src/lib/server-init.ts`
2. `apps/web/src/lib/gateway/gateway-events-bridge.ts`
3. `apps/web/src/lib/gateway/session-sync.ts`
4. `apps/web/src/lib/gateway/health-monitor.ts`
5. `apps/web/src/lib/bot-social/auto-poster.ts`

### Modified Files (2)
6. `apps/web/src/collections/Bots.ts` (complete hooks)
7. `apps/web/src/collections/BotChannels.ts` (add encryption hook)

### Integration Point (1)
8. Next.js server hook to call `initializeWebSocketServer()` and `bridgeGatewayEvents()`

---

## Testing Strategy

After implementing fixes, test in this order:

1. **WebSocket Connection**: `wscat -c ws://localhost:3000/ws`
2. **Bot Lifecycle**: Create bot → Start → Verify status updates → Stop
3. **Real-time Events**: Subscribe to `bot:<botId>:status` room, verify broadcasts
4. **Session Sync**: Send message to bot, verify session appears in admin UI
5. **Config Sync**: Update bot config, verify gateway reloads
6. **Health Monitor**: Kill gateway process manually, verify DB updates
7. **Encryption**: Add channel credentials, verify encrypted in database

---

## Next Steps

1. ✅ Review this analysis
2. ⏳ Implement P0 fixes
3. ⏳ Test integration end-to-end
4. ⏳ Implement P1 fixes
5. ⏳ Deploy to staging
6. ⏳ Load testing
7. ⏳ Production deployment

---

**Last Updated**: 2026-02-02
**Review Status**: Pending approval for implementation

import { watch, type FSWatcher } from 'node:fs'
import { readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Payload } from 'payload'

/**
 * Session Sync Service
 *
 * Watches OpenClaw gateway session files (JSONL format) and syncs them
 * to the Payload CMS Sessions collection for admin UI visibility and analytics.
 *
 * OpenClaw stores sessions at:
 * /var/openclaw/bots/<agentId>/sessions/<sessionKey>.jsonl
 *
 * Each line is a JSON object representing one conversation turn.
 */

interface SessionTurn {
  role: 'user' | 'assistant'
  content: string
  timestamp: string
  model?: string
  channel?: string
  peer?: string
  toolUse?: Array<{ name: string; input: any }>
}

export class SessionSyncService {
  private watchers: Map<string, FSWatcher> = new Map()

  constructor(private payload: Payload) {}

  /**
   * Watch gateway session files for a specific bot
   */
  async watchBotSessions(
    botId: string | number,
    agentId: string
  ): Promise<void> {
    const sessionDir = `/var/openclaw/bots/${agentId}/sessions`

    // Check if directory exists
    try {
      await access(sessionDir)
    } catch (error) {
      this.payload.logger.warn(
        `Session directory not found for bot ${agentId}: ${sessionDir}`
      )
      return
    }

    // Watch for file changes
    const watcher = watch(
      sessionDir,
      { persistent: true },
      async (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) {
          return
        }

        try {
          await this.syncSessionFile(botId, agentId, filename, sessionDir)
        } catch (error) {
          this.payload.logger.error(
            `Failed to sync session ${filename} for bot ${agentId}: ${error}`
          )
        }
      }
    )

    this.watchers.set(String(botId), watcher)

    this.payload.logger.info(
      `Watching sessions for bot ${agentId} at ${sessionDir}`
    )

    // Sync existing sessions on startup
    await this.syncExistingSessions(botId, agentId, sessionDir)
  }

  /**
   * Stop watching sessions for a bot
   */
  stopWatching(botId: string | number): void {
    const watcher = this.watchers.get(String(botId))
    if (watcher) {
      watcher.close()
      this.watchers.delete(String(botId))
      this.payload.logger.info(`Stopped watching sessions for bot ${botId}`)
    }
  }

  /**
   * Stop all watchers (cleanup on shutdown)
   */
  stopAllWatchers(): void {
    for (const [botId, watcher] of this.watchers.entries()) {
      watcher.close()
      this.payload.logger.info(`Stopped watching sessions for bot ${botId}`)
    }
    this.watchers.clear()
  }

  /**
   * Sync all existing session files on startup
   */
  private async syncExistingSessions(
    botId: string | number,
    agentId: string,
    sessionDir: string
  ): Promise<void> {
    try {
      const { readdir } = await import('node:fs/promises')
      const files = await readdir(sessionDir)

      for (const filename of files) {
        if (filename.endsWith('.jsonl')) {
          await this.syncSessionFile(botId, agentId, filename, sessionDir)
        }
      }

      this.payload.logger.info(
        `Synced ${files.length} existing sessions for bot ${agentId}`
      )
    } catch (error) {
      this.payload.logger.error(
        `Failed to sync existing sessions for bot ${agentId}: ${error}`
      )
    }
  }

  /**
   * Sync a single session file to database
   */
  private async syncSessionFile(
    botId: string | number,
    agentId: string,
    filename: string,
    sessionDir: string
  ): Promise<void> {
    const sessionFilePath = join(sessionDir, filename)

    // Read session file
    const content = await readFile(sessionFilePath, 'utf-8')
    if (!content.trim()) {
      return // Empty file
    }

    const lines = content.trim().split('\n')
    const sessionData: SessionTurn[] = []

    // Parse JSONL
    for (const line of lines) {
      try {
        const turn = JSON.parse(line)
        sessionData.push(turn)
      } catch (error) {
        this.payload.logger.warn(
          `Failed to parse line in ${filename}: ${error}`
        )
      }
    }

    if (sessionData.length === 0) {
      return // No valid data
    }

    // Extract session metadata
    const sessionKey = filename.replace('.jsonl', '')
    const messageCount = sessionData.length
    const lastTurn = sessionData[sessionData.length - 1]

    // Determine channel and peer from session data
    const channel = this.extractChannel(sessionData)
    const peer = this.extractPeer(sessionData)

    // Check if session already exists
    const existing = await this.payload.find({
      collection: 'sessions',
      where: {
        sessionKey: {
          equals: sessionKey
        }
      }
    })

    // Prepare session record
    const sessionRecord = {
      bot: botId,
      sessionKey,
      channel: channel || 'unknown',
      peer: peer || 'unknown',
      messageCount,
      lastMessage: new Date(lastTurn.timestamp || Date.now()),
      transcript: this.generateTranscriptPreview(sessionData),
      deliveryContext: {
        channel,
        peer
      },
      metadata: {
        model: lastTurn.model,
        toolsUsed: this.extractToolsUsed(sessionData),
        firstMessage: new Date(sessionData[0].timestamp || Date.now())
      }
    }

    try {
      if (existing.docs.length > 0) {
        // Update existing session
        await this.payload.update({
          collection: 'sessions',
          id: existing.docs[0].id,
          data: sessionRecord
        })

        this.payload.logger.debug(
          `Updated session ${sessionKey} for bot ${agentId}`
        )
      } else {
        // Create new session
        await this.payload.create({
          collection: 'sessions',
          data: sessionRecord
        })

        this.payload.logger.info(
          `Created new session ${sessionKey} for bot ${agentId}`
        )
      }
    } catch (error) {
      this.payload.logger.error(
        `Failed to save session ${sessionKey}: ${error}`
      )
    }
  }

  /**
   * Extract channel from session data
   */
  private extractChannel(sessionData: SessionTurn[]): string | null {
    for (const turn of sessionData) {
      if (turn.channel) {
        return turn.channel
      }
    }
    return null
  }

  /**
   * Extract peer (user ID, group ID) from session data
   */
  private extractPeer(sessionData: SessionTurn[]): string | null {
    for (const turn of sessionData) {
      if (turn.peer) {
        return turn.peer
      }
    }
    return null
  }

  /**
   * Generate a preview of the conversation transcript
   */
  private generateTranscriptPreview(sessionData: SessionTurn[]): string {
    // Get last 5 messages
    const recent = sessionData.slice(-5)

    return recent
      .map((turn) => {
        const role = turn.role === 'user' ? 'User' : 'Assistant'
        const content = turn.content?.substring(0, 100) || '[No content]'
        const truncated = content.length > 100 ? '...' : ''
        return `[${role}]: ${content}${truncated}`
      })
      .join('\n\n')
  }

  /**
   * Extract list of tools used in conversation
   */
  private extractToolsUsed(sessionData: SessionTurn[]): string[] {
    const tools = new Set<string>()

    for (const turn of sessionData) {
      if (turn.toolUse && Array.isArray(turn.toolUse)) {
        for (const tool of turn.toolUse) {
          if (tool.name) {
            tools.add(tool.name)
          }
        }
      }
    }

    return Array.from(tools)
  }
}

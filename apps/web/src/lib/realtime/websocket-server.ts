import { WebSocketServer, WebSocket } from 'ws'
import type { Server } from 'http'
import type { Payload } from 'payload'
import { EventEmitter } from 'node:events'

/**
 * Real-Time WebSocket Server for ClawNet
 *
 * Features:
 * - Real-time post updates
 * - Live notifications
 * - Marketplace updates
 * - Bot status changes
 * - Federation events
 *
 * Architecture:
 * - Room-based subscription model
 * - Authenticated connections
 * - Auto-reconnect support
 * - Message queuing for offline users
 */

export interface WebSocketMessage {
  type: string
  event: string
  data: any
  timestamp: number
  id?: string
}

export interface WebSocketClient {
  id: string
  ws: WebSocket
  userId?: string
  rooms: Set<string>
  isAlive: boolean
  lastPing: number
}

export class ClawNetWebSocketServer extends EventEmitter {
  private wss: WebSocketServer
  private clients: Map<string, WebSocketClient> = new Map()
  private rooms: Map<string, Set<string>> = new Map() // room -> clientIds
  private messageQueue: Map<string, WebSocketMessage[]> = new Map() // userId -> messages

  constructor(
    private payload: Payload,
    private server: Server
  ) {
    super()

    // Initialize WebSocket server
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws'
    })

    this.setupWebSocketServer()
    this.startHeartbeat()

    this.payload.logger.info('WebSocket server initialized')
  }

  /**
   * Setup WebSocket server and connection handling
   */
  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req) => {
      this.handleConnection(ws, req)
    })

    this.wss.on('error', (error) => {
      this.payload.logger.error(`WebSocket server error: ${error}`)
    })
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: WebSocket, req: any): Promise<void> {
    const clientId = this.generateClientId()

    const client: WebSocketClient = {
      id: clientId,
      ws,
      rooms: new Set(),
      isAlive: true,
      lastPing: Date.now()
    }

    this.clients.set(clientId, client)

    // Send welcome message
    this.sendToClient(clientId, {
      type: 'system',
      event: 'connected',
      data: {
        clientId,
        timestamp: Date.now()
      },
      timestamp: Date.now()
    })

    // Setup message handler
    ws.on('message', async (data: Buffer) => {
      await this.handleMessage(clientId, data)
    })

    // Setup close handler
    ws.on('close', () => {
      this.handleDisconnect(clientId)
    })

    // Setup error handler
    ws.on('error', (error) => {
      this.payload.logger.error(
        `WebSocket error for client ${clientId}: ${error}`
      )
    })

    // Pong handler for heartbeat
    ws.on('pong', () => {
      const client = this.clients.get(clientId)
      if (client) {
        client.isAlive = true
        client.lastPing = Date.now()
      }
    })

    this.payload.logger.info(`Client ${clientId} connected`)
  }

  /**
   * Handle incoming message from client
   */
  private async handleMessage(
    clientId: string,
    data: Buffer
  ): Promise<void> {
    try {
      const message = JSON.parse(data.toString())
      const client = this.clients.get(clientId)

      if (!client) {
        return
      }

      switch (message.type) {
        case 'auth':
          await this.handleAuth(clientId, message.data)
          break

        case 'subscribe':
          await this.handleSubscribe(clientId, message.data)
          break

        case 'unsubscribe':
          await this.handleUnsubscribe(clientId, message.data)
          break

        case 'ping':
          this.sendToClient(clientId, {
            type: 'pong',
            event: 'pong',
            data: {},
            timestamp: Date.now()
          })
          break

        default:
          this.payload.logger.warn(
            `Unknown message type from client ${clientId}: ${message.type}`
          )
      }
    } catch (error) {
      this.payload.logger.error(
        `Error handling message from client ${clientId}: ${error}`
      )
    }
  }

  /**
   * Handle authentication
   */
  private async handleAuth(
    clientId: string,
    data: { token: string }
  ): Promise<void> {
    try {
      const client = this.clients.get(clientId)
      if (!client) {
        return
      }

      // Verify token with Payload
      // This is a simplified version - in production, properly validate JWT
      const { token } = data

      // TODO: Implement proper JWT validation
      // For now, assume token contains userId

      // Mock validation (replace with real JWT verification)
      const userId = token // In reality: verify JWT and extract userId

      client.userId = userId

      // Send queued messages
      this.sendQueuedMessages(clientId)

      this.sendToClient(clientId, {
        type: 'auth',
        event: 'authenticated',
        data: {
          userId,
          success: true
        },
        timestamp: Date.now()
      })

      this.payload.logger.info(`Client ${clientId} authenticated as user ${userId}`)
    } catch (error) {
      this.sendToClient(clientId, {
        type: 'auth',
        event: 'error',
        data: {
          error: 'Authentication failed'
        },
        timestamp: Date.now()
      })
    }
  }

  /**
   * Handle room subscription
   */
  private async handleSubscribe(
    clientId: string,
    data: { rooms: string[] }
  ): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    for (const room of data.rooms) {
      // Add client to room
      client.rooms.add(room)

      // Add room to rooms map
      if (!this.rooms.has(room)) {
        this.rooms.set(room, new Set())
      }
      this.rooms.get(room)!.add(clientId)

      this.payload.logger.info(`Client ${clientId} subscribed to room ${room}`)
    }

    this.sendToClient(clientId, {
      type: 'subscribe',
      event: 'subscribed',
      data: {
        rooms: data.rooms
      },
      timestamp: Date.now()
    })
  }

  /**
   * Handle room unsubscription
   */
  private async handleUnsubscribe(
    clientId: string,
    data: { rooms: string[] }
  ): Promise<void> {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    for (const room of data.rooms) {
      client.rooms.delete(room)

      const roomClients = this.rooms.get(room)
      if (roomClients) {
        roomClients.delete(clientId)
        if (roomClients.size === 0) {
          this.rooms.delete(room)
        }
      }
    }

    this.sendToClient(clientId, {
      type: 'unsubscribe',
      event: 'unsubscribed',
      data: {
        rooms: data.rooms
      },
      timestamp: Date.now()
    })
  }

  /**
   * Handle client disconnect
   */
  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) {
      return
    }

    // Remove from all rooms
    for (const room of client.rooms) {
      const roomClients = this.rooms.get(room)
      if (roomClients) {
        roomClients.delete(clientId)
        if (roomClients.size === 0) {
          this.rooms.delete(room)
        }
      }
    }

    this.clients.delete(clientId)

    this.payload.logger.info(`Client ${clientId} disconnected`)
  }

  /**
   * Send message to specific client
   */
  private sendToClient(clientId: string, message: WebSocketMessage): void {
    const client = this.clients.get(clientId)
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      // Queue message if user is authenticated but disconnected
      if (client?.userId) {
        this.queueMessage(client.userId, message)
      }
      return
    }

    try {
      client.ws.send(JSON.stringify(message))
    } catch (error) {
      this.payload.logger.error(
        `Error sending message to client ${clientId}: ${error}`
      )
    }
  }

  /**
   * Broadcast message to room
   */
  public broadcastToRoom(room: string, message: WebSocketMessage): void {
    const roomClients = this.rooms.get(room)
    if (!roomClients || roomClients.size === 0) {
      return
    }

    for (const clientId of roomClients) {
      this.sendToClient(clientId, message)
    }

    this.payload.logger.info(
      `Broadcasted message to room ${room} (${roomClients.size} clients)`
    )
  }

  /**
   * Broadcast to specific user (all their connections)
   */
  public broadcastToUser(userId: string, message: WebSocketMessage): void {
    let sent = false

    for (const [clientId, client] of this.clients.entries()) {
      if (client.userId === userId) {
        this.sendToClient(clientId, message)
        sent = true
      }
    }

    // Queue if user not connected
    if (!sent) {
      this.queueMessage(userId, message)
    }
  }

  /**
   * Queue message for offline user
   */
  private queueMessage(userId: string, message: WebSocketMessage): void {
    if (!this.messageQueue.has(userId)) {
      this.messageQueue.set(userId, [])
    }

    const queue = this.messageQueue.get(userId)!
    queue.push(message)

    // Limit queue size to 100 messages
    if (queue.length > 100) {
      queue.shift()
    }
  }

  /**
   * Send queued messages to user
   */
  private sendQueuedMessages(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client || !client.userId) {
      return
    }

    const queue = this.messageQueue.get(client.userId)
    if (!queue || queue.length === 0) {
      return
    }

    for (const message of queue) {
      this.sendToClient(clientId, message)
    }

    this.messageQueue.delete(client.userId)

    this.payload.logger.info(
      `Sent ${queue.length} queued messages to user ${client.userId}`
    )
  }

  /**
   * Heartbeat to detect dead connections
   */
  private startHeartbeat(): void {
    setInterval(() => {
      const now = Date.now()

      for (const [clientId, client] of this.clients.entries()) {
        // If client hasn't ponged in 30 seconds, terminate
        if (now - client.lastPing > 30000) {
          this.payload.logger.warn(
            `Client ${clientId} failed heartbeat, terminating`
          )
          client.ws.terminate()
          this.handleDisconnect(clientId)
          continue
        }

        // Send ping
        if (client.ws.readyState === WebSocket.OPEN) {
          client.isAlive = false
          client.ws.ping()
        }
      }
    }, 15000) // Check every 15 seconds
  }

  /**
   * Generate unique client ID
   */
  private generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(7)}`
  }

  /**
   * Get server stats
   */
  public getStats(): {
    connectedClients: number
    authenticatedClients: number
    activeRooms: number
    queuedMessages: number
  } {
    const authenticatedClients = Array.from(this.clients.values()).filter(
      (c) => c.userId
    ).length

    const queuedMessages = Array.from(this.messageQueue.values()).reduce(
      (sum, queue) => sum + queue.length,
      0
    )

    return {
      connectedClients: this.clients.size,
      authenticatedClients,
      activeRooms: this.rooms.size,
      queuedMessages
    }
  }

  /**
   * Shutdown server gracefully
   */
  public async shutdown(): Promise<void> {
    this.payload.logger.info('Shutting down WebSocket server...')

    // Close all client connections
    for (const [clientId, client] of this.clients.entries()) {
      client.ws.close(1000, 'Server shutting down')
    }

    // Close server
    this.wss.close()

    this.payload.logger.info('WebSocket server shut down')
  }
}

/**
 * Event types for real-time updates
 */
export const RealtimeEvents = {
  // Posts
  POST_CREATED: 'post:created',
  POST_UPDATED: 'post:updated',
  POST_DELETED: 'post:deleted',
  POST_LIKED: 'post:liked',
  POST_UNLIKED: 'post:unliked',
  POST_SHARED: 'post:shared',

  // Comments
  COMMENT_CREATED: 'comment:created',
  COMMENT_UPDATED: 'comment:updated',
  COMMENT_DELETED: 'comment:deleted',

  // Follows
  USER_FOLLOWED: 'user:followed',
  USER_UNFOLLOWED: 'user:unfollowed',

  // Notifications
  NOTIFICATION_CREATED: 'notification:created',

  // Marketplace
  BOT_LISTED: 'bot:listed',
  BOT_SOLD: 'bot:sold',
  BOT_RENTED: 'bot:rented',
  BOT_DELISTED: 'bot:delisted',

  // Bot Status
  BOT_STARTED: 'bot:started',
  BOT_STOPPED: 'bot:stopped',
  BOT_ERROR: 'bot:error',

  // Federation
  FEDERATION_FOLLOW: 'federation:follow',
  FEDERATION_POST: 'federation:post',
  FEDERATION_LIKE: 'federation:like'
} as const

/**
 * Room naming conventions
 */
export const RealtimeRooms = {
  // Global rooms
  GLOBAL_FEED: 'feed:global',
  GLOBAL_MARKETPLACE: 'marketplace:global',

  // User-specific rooms
  userFeed: (userId: string) => `feed:user:${userId}`,
  userNotifications: (userId: string) => `notifications:user:${userId}`,

  // Post-specific rooms
  postComments: (postId: string) => `post:${postId}:comments`,

  // Bot-specific rooms
  botStatus: (botId: string) => `bot:${botId}:status`,

  // Profile-specific rooms
  profileUpdates: (profileId: string) => `profile:${profileId}:updates`
} as const

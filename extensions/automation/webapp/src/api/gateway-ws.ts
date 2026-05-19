// WebSocket JSON-RPC 2.0 client for OpenClaw Gateway.

export type JsonRpcId = number

export type GatewayEventHandler = (payload: unknown) => void

type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: Record<string, unknown>
}

type JsonRpcSuccessResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  result: unknown
}

type JsonRpcErrorResponse = {
  jsonrpc: '2.0'
  id: JsonRpcId
  error: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcEventMessage = {
  jsonrpc?: '2.0'
  method: string
  params?: unknown
}

type PendingCall = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  timeout: ReturnType<typeof setTimeout>
}

type GatewayWsRpcClientOptions = {
  url: string
  requestTimeoutMs?: number
  minReconnectDelayMs?: number
  maxReconnectDelayMs?: number
}

export class GatewayWsRpcClient {
  private readonly url: string
  private readonly requestTimeoutMs: number
  private readonly minReconnectDelayMs: number
  private readonly maxReconnectDelayMs: number

  private ws: WebSocket | null = null
  private connecting: Promise<void> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempts = 0
  private disconnectedByUser = false

  private nextId: JsonRpcId = 1
  private readonly pendingCalls = new Map<JsonRpcId, PendingCall>()
  private readonly eventSubscribers = new Map<string, Set<GatewayEventHandler>>()

  constructor(options: GatewayWsRpcClientOptions) {
    this.url = options.url
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000
    this.minReconnectDelayMs = options.minReconnectDelayMs ?? 500
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 10_000
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    if (this.connecting) {
      return this.connecting
    }

    this.disconnectedByUser = false
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      let settled = false

      const clearConnecting = () => {
        this.connecting = null
      }

      socket.onopen = () => {
        settled = true
        this.ws = socket
        this.reconnectAttempts = 0
        clearConnecting()
        resolve()
      }

      socket.onmessage = (event) => {
        this.handleMessage(event.data)
      }

      socket.onclose = () => {
        if (this.ws === socket) {
          this.ws = null
        }
        if (!settled) {
          settled = true
          clearConnecting()
          reject(new Error('WebSocket 連線失敗'))
          return
        }
        this.rejectAllPendingCalls(new Error('WebSocket 連線已中斷'))
        this.scheduleReconnect()
      }

      socket.onerror = () => {
        if (!settled) {
          settled = true
          clearConnecting()
          reject(new Error('WebSocket 發生錯誤'))
        }
      }
    })

    return this.connecting
  }

  disconnect(): void {
    this.disconnectedByUser = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close(1000, 'manual disconnect')
    }
    this.ws = null
    this.rejectAllPendingCalls(new Error('已手動中斷連線'))
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.connect()

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket 尚未連線')
    }

    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    }

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id)
        reject(new Error(`RPC 請求逾時：${method}`))
      }, this.requestTimeoutMs)

      this.pendingCalls.set(id, { resolve, reject, timeout })
      this.ws?.send(JSON.stringify(request))
    })
  }

  subscribe(event: string, handler: GatewayEventHandler): () => void {
    const handlers = this.eventSubscribers.get(event) ?? new Set<GatewayEventHandler>()
    handlers.add(handler)
    this.eventSubscribers.set(event, handlers)

    return () => {
      const current = this.eventSubscribers.get(event)
      if (!current) {
        return
      }
      current.delete(handler)
      if (current.size === 0) {
        this.eventSubscribers.delete(event)
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.disconnectedByUser || this.connecting || this.reconnectTimer) {
      return
    }

    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.minReconnectDelayMs * 2 ** this.reconnectAttempts,
    )
    this.reconnectAttempts += 1

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      try {
        await this.connect()
      } catch {
        this.scheduleReconnect()
      }
    }, delay)
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      return
    }

    let message: unknown
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }

    if (!message || typeof message !== 'object') {
      return
    }

    if ('id' in message) {
      this.handleRpcResponse(message as JsonRpcSuccessResponse | JsonRpcErrorResponse)
      return
    }

    if ('method' in message) {
      this.handleEventMessage(message as JsonRpcEventMessage)
    }
  }

  private handleRpcResponse(message: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pendingCalls.get(message.id)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingCalls.delete(message.id)

    if ('error' in message) {
      pending.reject(
        new Error(
          `RPC 錯誤 ${message.error.code}: ${message.error.message}`,
        ),
      )
      return
    }

    pending.resolve(message.result)
  }

  private handleEventMessage(message: JsonRpcEventMessage): void {
    const handlers = this.eventSubscribers.get(message.method)
    if (!handlers || handlers.size === 0) {
      return
    }

    for (const handler of handlers) {
      handler(message.params)
    }
  }

  private rejectAllPendingCalls(error: Error): void {
    for (const [id, pending] of this.pendingCalls.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingCalls.delete(id)
    }
  }
}

export function createGatewayWsRpcClient(
  options: Partial<GatewayWsRpcClientOptions> = {},
): GatewayWsRpcClient {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
  const defaultUrl = `${protocol}://${window.location.host}/ws`
  return new GatewayWsRpcClient({
    url: options.url ?? defaultUrl,
    requestTimeoutMs: options.requestTimeoutMs,
    minReconnectDelayMs: options.minReconnectDelayMs,
    maxReconnectDelayMs: options.maxReconnectDelayMs,
  })
}

import { useEffect, useState } from 'react'
import { useGateway } from './useGateway'

type StreamPayload = {
  sessionKey?: string
  line?: unknown
  chunk?: unknown
  text?: unknown
  done?: unknown
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function parsePayload(payload: unknown): StreamPayload {
  if (!payload || typeof payload !== 'object') {
    return {}
  }
  const record = payload as Record<string, unknown>
  return {
    sessionKey: typeof record.sessionKey === 'string' ? record.sessionKey : undefined,
    line: record.line,
    chunk: record.chunk,
    text: record.text,
    done: record.done,
  }
}

function matchSession(sessionKey: string, payloadSessionKey?: string): boolean {
  if (!payloadSessionKey) {
    return true
  }
  return payloadSessionKey === sessionKey
}

export function useStream(sessionKey: string) {
  const { subscribe } = useGateway()
  const [lines, setLines] = useState<string[]>([])
  const [isStreaming, setIsStreaming] = useState(false)

  useEffect(() => {
    setLines([])
    setIsStreaming(false)

    const appendLine = (payload: unknown) => {
      const parsed = parsePayload(payload)
      if (!matchSession(sessionKey, parsed.sessionKey)) {
        return
      }

      const line =
        asString(parsed.line) ??
        asString(parsed.chunk) ??
        asString(parsed.text)

      if (line) {
        setLines((prev) => [...prev.slice(-399), line])
      }

      if (parsed.done === true) {
        setIsStreaming(false)
      }
    }

    const markStart = (payload: unknown) => {
      const parsed = parsePayload(payload)
      if (!matchSession(sessionKey, parsed.sessionKey)) {
        return
      }
      setIsStreaming(true)
    }

    const markEnd = (payload: unknown) => {
      const parsed = parsePayload(payload)
      if (!matchSession(sessionKey, parsed.sessionKey)) {
        return
      }
      setIsStreaming(false)
    }

    const unsubscribers = [
      subscribe('agent.stream.start', markStart),
      subscribe('agent.stream.chunk', appendLine),
      subscribe('agent.stream.end', markEnd),
      subscribe('agent.output', appendLine),
      subscribe('agent.stream', appendLine),
    ]

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [sessionKey, subscribe])

  const clear = () => {
    setLines([])
  }

  return { lines, isStreaming, clear }
}

import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import './CodeWorkspace.css'

type StreamEventPayload = {
  line?: unknown
  diff?: unknown
}

function parsePayload(payload: unknown): StreamEventPayload {
  if (!payload || typeof payload !== 'object') {
    return {}
  }
  const record = payload as Record<string, unknown>
  return {
    line: record.line,
    diff: record.diff,
  }
}

function formatStreamLine(input: unknown): string | null {
  if (typeof input === 'string') {
    return input
  }
  if (typeof input === 'number' || typeof input === 'boolean') {
    return String(input)
  }
  return null
}

export function CodeWorkspace() {
  const [command, setCommand] = useState('')
  const [streamLines, setStreamLines] = useState<string[]>([])
  const [diffText, setDiffText] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const [connected, setConnected] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [statusText, setStatusText] = useState('')

  const terminalText = useMemo(() => streamLines.join('\n'), [streamLines])

  useEffect(() => {
    const client = createGatewayWsRpcClient()
    let unsubscribe: (() => void) | null = null

    void (async () => {
      try {
        await client.connect()
        setConnected(true)
        unsubscribe = client.subscribe('agent.output', (payload) => {
          const parsed = parsePayload(payload)
          const line = formatStreamLine(parsed.line)
          if (line) {
            setStreamLines((prev) => [...prev.slice(-399), line])
          }
          if (typeof parsed.diff === 'string') {
            setDiffText(parsed.diff)
          }
        })
      } catch {
        setConnected(false)
        setStatusText('WebSocket 尚未連線，請稍後重試。')
      }
    })()

    return () => {
      unsubscribe?.()
      client.disconnect()
    }
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = command.trim()
    if (!trimmed) {
      return
    }

    setSubmitting(true)
    setStatusText('')
    const client = createGatewayWsRpcClient()

    try {
      await client.connect()
      await client.call('chat.send', { message: trimmed })
      setStreamLines((prev) => [...prev.slice(-399), `$ ${trimmed}`])
      setCommand('')
      setStatusText('任務已送出。')
    } catch {
      setStatusText('送出失敗，請檢查 Gateway 連線。')
    } finally {
      client.disconnect()
      setSubmitting(false)
    }
  }

  function handleUndoLastLine() {
    setStreamLines((prev) => prev.slice(0, -1))
  }

  return (
    <section className="code-workspace">
      <header className="code-panel">
        <h1>程式碼工作區</h1>
        <p className="code-status">
          連線狀態：{connected ? '已連線' : '未連線'}
        </p>
      </header>

      <form className="code-panel code-form" onSubmit={handleSubmit}>
        <label htmlFor="taskCommand">任務指令</label>
        <div className="code-form-row">
          <input
            id="taskCommand"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="輸入要交給 Agent 的任務"
            autoComplete="off"
          />
          <button type="submit" disabled={submitting}>
            提交
          </button>
        </div>
      </form>

      <article className="code-panel">
        <h2>即時輸出</h2>
        <pre className="terminal-output">{terminalText || '尚無輸出'}</pre>
      </article>

      <article className="code-panel">
        <h2>操作</h2>
        <div className="code-actions">
          <button type="button" onClick={handleUndoLastLine}>
            撤銷一行
          </button>
          <button type="button" onClick={() => setShowDiff((prev) => !prev)}>
            {showDiff ? '收合 Diff' : '查看 Diff'}
          </button>
          <button type="button" onClick={() => setStreamLines([])}>
            清空輸出
          </button>
        </div>
        {statusText ? <p className="code-status">{statusText}</p> : null}
      </article>

      {showDiff ? (
        <article className="code-panel">
          <h2>Diff 檢視</h2>
          <pre className="diff-output">{diffText || '尚無 Diff 內容'}</pre>
        </article>
      ) : null}
    </section>
  )
}

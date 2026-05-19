import { useEffect, useMemo, useState } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import { useAppStore } from '../stores/app-store'
import './AgentControl.css'

function statusDotClass(status: string): string {
  const normalized = status.toLowerCase()
  if (normalized.includes('run') || normalized.includes('busy')) {
    return 'agent-dot agent-dot-busy'
  }
  if (normalized.includes('off') || normalized.includes('error')) {
    return 'agent-dot agent-dot-offline'
  }
  return 'agent-dot agent-dot-online'
}

export function AgentControl() {
  const { agents, refreshAll } = useAppStore((state) => ({
    agents: state.agents,
    refreshAll: state.refreshAll,
  }))

  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (agents.length === 0) {
      void refreshAll()
    }
  }, [agents.length, refreshAll])

  const sortedAgents = useMemo(
    () =>
      [...agents].sort((a, b) =>
        a.name.localeCompare(b.name, 'zh-Hant', { sensitivity: 'base' }),
      ),
    [agents],
  )

  async function switchAgent(agentId: string): Promise<void> {
    setBusy(true)
    setMessage('')
    const client = createGatewayWsRpcClient()
    try {
      await client.connect()
      await client.call('config.patch', { activeAgentId: agentId })
      await refreshAll()
      setMessage(`已切換 Agent：${agentId}`)
    } catch {
      setMessage('切換 Agent 失敗，請稍後重試。')
    } finally {
      client.disconnect()
      setBusy(false)
    }
  }

  async function resetAgentSession(agentId: string): Promise<void> {
    setBusy(true)
    setMessage('')
    const client = createGatewayWsRpcClient()
    try {
      await client.connect()
      await client.call('sessions.reset', { agentId })
      setMessage(`已重置 Agent 對話：${agentId}`)
    } catch {
      setMessage('重置對話失敗，請稍後重試。')
    } finally {
      client.disconnect()
      setBusy(false)
    }
  }

  return (
    <section className="agent-control">
      <header className="agent-panel">
        <h1>Agent 管理</h1>
        <button
          type="button"
          className="agent-btn-primary"
          disabled={busy}
          onClick={() => void refreshAll()}
        >
          刷新列表
        </button>
      </header>

      {message ? <p className="agent-message">{message}</p> : null}

      {sortedAgents.length === 0 ? (
        <article className="agent-panel">
          <p>目前尚無 Agent 資料。</p>
        </article>
      ) : (
        <div className="agent-grid">
          {sortedAgents.map((agent) => (
            <article key={agent.id} className="agent-panel">
              <div className="agent-row">
                <h2>{agent.name}</h2>
                <span className={statusDotClass(agent.status)} aria-hidden="true" />
              </div>
              <p className="agent-meta">ID：{agent.id}</p>
              <p className="agent-meta">狀態：{agent.status}</p>
              <p className="agent-meta">模型：{agent.model ?? '未設定'}</p>
              <p className="agent-meta">Session Turns：{agent.turns ?? 0}</p>
              <div className="agent-actions">
                <button
                  type="button"
                  className="agent-btn-primary"
                  disabled={busy}
                  onClick={() => void switchAgent(agent.id)}
                >
                  切換
                </button>
                <button
                  type="button"
                  className="agent-btn-secondary"
                  disabled={busy}
                  onClick={() => void resetAgentSession(agent.id)}
                >
                  重置對話
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

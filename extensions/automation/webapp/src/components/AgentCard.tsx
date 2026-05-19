import type { AgentInfo } from '../stores/app-store'
import './AgentCard.css'

type AgentCardProps = {
  agent: AgentInfo
  onSwitch?: (agentId: string) => void
  onReset?: (agentId: string) => void
  disabled?: boolean
}

function statusMeta(status: string): { emoji: string; className: string; text: string } {
  const normalized = status.toLowerCase()
  if (normalized.includes('run') || normalized.includes('busy')) {
    return { emoji: '🟡', className: 'agent-status-dot is-busy', text: 'busy' }
  }
  if (normalized.includes('off') || normalized.includes('error')) {
    return { emoji: '🔴', className: 'agent-status-dot is-offline', text: 'offline' }
  }
  return { emoji: '🟢', className: 'agent-status-dot is-online', text: 'online' }
}

export function AgentCard({ agent, onSwitch, onReset, disabled = false }: AgentCardProps) {
  const meta = statusMeta(agent.status)

  return (
    <article className="agent-card">
      <header className="agent-card-head">
        <div className="agent-title-wrap">
          <h3>{agent.name}</h3>
          <p>{agent.id}</p>
        </div>
        <div className="agent-status-wrap">
          <span aria-hidden="true">{meta.emoji}</span>
          <span className={meta.className} />
          <span>{meta.text}</span>
        </div>
      </header>

      <dl className="agent-metrics">
        <div>
          <dt>模型</dt>
          <dd>{agent.model ?? '未設定'}</dd>
        </div>
        <div>
          <dt>Session Turns</dt>
          <dd>{agent.turns ?? 0}</dd>
        </div>
      </dl>

      <div className="agent-card-actions">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSwitch?.(agent.id)}
        >
          切換
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onReset?.(agent.id)}
        >
          重置對話
        </button>
      </div>
    </article>
  )
}

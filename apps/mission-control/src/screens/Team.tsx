import { useStore } from '../store'
import type { Agent, AgentStatus } from '../types'
import { useQuery } from '@tanstack/react-query'
import { getGatewayHealth } from '../api/openclaw'
import { Activity, Cpu, DollarSign, CheckSquare, Zap } from 'lucide-react'
import clsx from 'clsx'

const STATUS_CONFIG: Record<AgentStatus, { label: string; color: string; dot: string }> = {
  idle: { label: 'Idle', color: 'text-neutral-400', dot: 'bg-neutral-500' },
  researching: { label: 'Researching', color: 'text-cyan-400', dot: 'bg-cyan-400 animate-pulse' },
  coding: { label: 'Coding', color: 'text-blue-400', dot: 'bg-blue-400 animate-pulse' },
  reviewing: { label: 'Reviewing', color: 'text-amber-400', dot: 'bg-amber-400' },
  meeting: { label: 'In Meeting', color: 'text-violet-400', dot: 'bg-violet-400' },
  offline: { label: 'Offline', color: 'text-neutral-600', dot: 'bg-neutral-700' },
}

function AgentCard({ agent }: { agent: Agent }) {
  const { tasks } = useStore()
  const activeTasks = tasks.filter(t => t.agentId === agent.id && t.status === 'in_progress')
  const sc = STATUS_CONFIG[agent.status]

  return (
    <div className="card hover:border-white/[0.12] transition-all">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
          style={{ background: agent.color + '22', border: `1px solid ${agent.color}44` }}>
          {agent.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-white">{agent.name}</span>
            <div className={clsx('flex items-center gap-1 text-[10px]', sc.color)}>
              <div className={clsx('w-1.5 h-1.5 rounded-full', sc.dot)} />
              {sc.label}
            </div>
          </div>
          <div className="text-xs text-neutral-500">{agent.role}</div>
        </div>
      </div>

      <p className="text-xs text-neutral-400 mb-3 line-clamp-2">{agent.description}</p>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        {[
          { icon: CheckSquare, label: 'Done', val: agent.tasksCompleted },
          { icon: Activity, label: 'Tokens', val: (agent.tokensUsed / 1000).toFixed(0) + 'k' },
          { icon: DollarSign, label: 'Today', val: '$' + agent.costToday.toFixed(2) },
        ].map(({ icon: Icon, label, val }) => (
          <div key={label} className="bg-white/[0.03] rounded-lg px-2 py-1.5 text-center">
            <div className="text-sm font-semibold text-white">{val}</div>
            <div className="text-[10px] text-neutral-500">{label}</div>
          </div>
        ))}
      </div>

      {/* Skills */}
      <div className="flex flex-wrap gap-1 mb-3">
        {agent.skills.map(s => (
          <span key={s} className="flex items-center gap-0.5 badge bg-white/[0.05] text-neutral-400 text-[10px]">
            <Zap size={8} />
            {s}
          </span>
        ))}
      </div>

      {/* Active tasks */}
      {activeTasks.length > 0 && (
        <div className="border-t border-white/[0.06] pt-2">
          <div className="text-[10px] text-neutral-600 mb-1">Active tasks</div>
          {activeTasks.map(t => (
            <div key={t.id} className="text-xs text-neutral-300 flex items-center gap-1.5">
              <div className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
              {t.title}
            </div>
          ))}
        </div>
      )}

      {/* Model badge */}
      <div className="mt-3 flex items-center justify-between">
        <span className="badge bg-white/[0.04] text-neutral-500 text-[10px] font-mono">{agent.model}</span>
        <span className="text-[10px] text-neutral-600">
          Active {new Date(agent.lastActiveAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
    </div>
  )
}

export function Team() {
  const { agents } = useStore()
  const { data: health } = useQuery({ queryKey: ['gateway-health'], queryFn: getGatewayHealth, refetchInterval: 30000 })

  return (
    <div className="p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm text-neutral-400">
            {agents.filter(a => a.status !== 'offline').length} active of {agents.length} agents
            {' · '}
            <span className={health?.online ? 'text-emerald-400' : 'text-neutral-500'}>
              Gateway {health?.online ? 'online' : 'offline'}
            </span>
          </p>
        </div>
        <button className="btn-primary flex items-center gap-1.5">
          <span>+ Add Agent</span>
        </button>
      </div>

      {/* Mission Statement */}
      <div className="card mb-5 border-blue-500/20 bg-blue-500/5">
        <div className="text-xs text-blue-400 font-semibold mb-1">Team Mission</div>
        <p className="text-sm text-neutral-300">
          Automate Jason's day-to-day: run Ora Labs ops, handle communications, monitor crypto, produce content,
          and keep the server healthy — all while he sleeps or works on what matters most.
        </p>
      </div>

      {/* Agent cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {agents.map(a => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  )
}

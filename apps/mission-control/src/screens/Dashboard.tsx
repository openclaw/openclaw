import { useStore } from '../store'
import { useQuery } from '@tanstack/react-query'
import { getGatewayHealth } from '../api/openclaw'
import { Link } from 'react-router-dom'
import { CheckSquare, Brain, Users, FolderOpen, Zap, Activity, DollarSign, TrendingUp, ArrowRight } from 'lucide-react'
import clsx from 'clsx'
import type { AgentStatus } from '../types'

const STATUS_DOT: Record<AgentStatus, string> = {
  idle: 'bg-neutral-500',
  researching: 'bg-cyan-400 animate-pulse',
  coding: 'bg-blue-400 animate-pulse',
  reviewing: 'bg-amber-400',
  meeting: 'bg-violet-400 animate-pulse',
  offline: 'bg-neutral-700',
}

export function Dashboard() {
  const { tasks, agents, projects, memories, skills: _s } = useStore()
  const { data: health } = useQuery({ queryKey: ['gateway-health'], queryFn: getGatewayHealth, refetchInterval: 30_000 })

  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const review = tasks.filter(t => t.status === 'review')
  const done = tasks.filter(t => t.status === 'done')
  const activeProjects = projects.filter(p => p.status === 'active')
  const totalCostToday = agents.reduce((s, a) => s + a.costToday, 0)
  const online = health?.online ?? false

  const STATS = [
    { icon: CheckSquare, label: 'In Progress', value: inProgress.length, sub: `${review.length} in review`, color: 'text-blue-400', to: '/tasks' },
    { icon: FolderOpen, label: 'Active Projects', value: activeProjects.length, sub: `${projects.length} total`, color: 'text-emerald-400', to: '/projects' },
    { icon: Users, label: 'Active Agents', value: agents.filter(a => a.status !== 'offline').length, sub: `${agents.length} total`, color: 'text-violet-400', to: '/team' },
    { icon: DollarSign, label: 'Cost Today', value: `$${totalCostToday.toFixed(2)}`, sub: 'All agents', color: 'text-amber-400', to: '/team' },
  ]

  return (
    <div className="p-5">
      {/* Welcome */}
      <div className="mb-5">
        <div className="text-lg font-semibold text-white">
          Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, Jason 👋
        </div>
        <div className="text-sm text-neutral-400 mt-0.5">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
          {' · '}
          <span className={online ? 'text-emerald-400' : 'text-neutral-500'}>
            Gateway {online ? 'online' : 'offline'}
          </span>
          {' · '}
          <span className="text-neutral-500">{inProgress.length} tasks in flight</span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        {STATS.map(({ icon: Icon, label, value, sub, color, to }) => (
          <Link key={label} to={to} className="card hover:border-white/[0.12] transition-all block">
            <div className="flex items-start justify-between mb-2">
              <Icon size={15} className={color} />
              <ArrowRight size={12} className="text-neutral-700" />
            </div>
            <div className={clsx('text-2xl font-bold', color)}>{value}</div>
            <div className="text-xs text-white mt-0.5">{label}</div>
            <div className="text-[10px] text-neutral-600 mt-0.5">{sub}</div>
          </Link>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Agent status */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <Activity size={14} />
              Agents
            </div>
            <Link to="/team" className="text-xs text-neutral-500 hover:text-white transition-colors">View all →</Link>
          </div>
          <div className="space-y-2">
            {agents.map(a => {
              const activeTasks = tasks.filter(t => t.agentId === a.id && t.status === 'in_progress')
              return (
                <div key={a.id} className="flex items-center gap-3 py-1">
                  <span className="text-base">{a.emoji}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white">{a.name}</span>
                      <div className={clsx('w-1.5 h-1.5 rounded-full shrink-0', STATUS_DOT[a.status])} />
                    </div>
                    <div className="text-[11px] text-neutral-500 truncate">
                      {activeTasks.length > 0 ? activeTasks[0].title : a.status === 'idle' ? 'Waiting for tasks' : a.status}
                    </div>
                  </div>
                  <div className="text-xs text-neutral-600">{a.tasksCompleted} done</div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Active tasks */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <CheckSquare size={14} />
              In Progress
            </div>
            <Link to="/tasks" className="text-xs text-neutral-500 hover:text-white transition-colors">View all →</Link>
          </div>
          <div className="space-y-2">
            {inProgress.slice(0, 5).map(t => {
              const agent = agents.find(a => a.id === t.agentId)
              return (
                <div key={t.id} className="flex items-center gap-2 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse shrink-0" />
                  <span className="text-sm text-neutral-200 flex-1 truncate">{t.title}</span>
                  {agent && <span className="text-sm">{agent.emoji}</span>}
                </div>
              )
            })}
            {inProgress.length === 0 && (
              <div className="text-sm text-neutral-600 py-2">No tasks in progress</div>
            )}
          </div>
        </div>

        {/* Projects progress */}
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="text-sm font-semibold text-white flex items-center gap-2">
              <FolderOpen size={14} />
              Projects
            </div>
            <Link to="/projects" className="text-xs text-neutral-500 hover:text-white transition-colors">View all →</Link>
          </div>
          <div className="space-y-3">
            {activeProjects.map(p => (
              <div key={p.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-1.5 text-sm text-white">
                    <span>{p.emoji}</span>
                    <span>{p.name}</span>
                  </div>
                  <span className="text-xs font-semibold" style={{ color: p.color }}>{p.progress}%</span>
                </div>
                <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${p.progress}%`, background: p.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Quick links */}
        <div className="card">
          <div className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <TrendingUp size={14} />
            Quick Access
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { to: '/standup', label: 'Daily Standup', emoji: '📋' },
              { to: '/skills', label: 'Skills (4)', emoji: '⚡' },
              { to: '/memory', label: 'Memory', emoji: '🧠' },
              { to: '/integrations', label: 'Integrations', emoji: '🔌' },
              { to: '/office', label: 'Office View', emoji: '🏢' },
              { to: '/system', label: 'System', emoji: '⚙️' },
            ].map(({ to, label, emoji }) => (
              <Link key={to} to={to}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] hover:bg-white/[0.07] border border-white/[0.04] hover:border-white/[0.1] transition-all text-sm text-neutral-300 hover:text-white">
                <span className="text-base">{emoji}</span>
                <span className="text-xs">{label}</span>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

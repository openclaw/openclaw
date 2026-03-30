import { useStore } from '../store'
import { format, subDays } from 'date-fns'
import { CheckCircle2, ArrowRight, AlertTriangle, Sparkles, RefreshCw } from 'lucide-react'
import { useState } from 'react'

export function Standup() {
  const { tasks, agents, projects } = useStore()
  const today = format(new Date(), 'yyyy-MM-dd')
  const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd')
  const [regenerating, setRegen] = useState(false)

  // Auto-generate standup from task state
  const doneRecently = tasks.filter(t =>
    t.status === 'done' && t.completedAt &&
    t.completedAt.slice(0, 10) >= yesterday
  )

  const inProgress = tasks.filter(t => t.status === 'in_progress')
  const review = tasks.filter(t => t.status === 'review')

  const blockers = [
    tasks.find(t => t.id === 't4') && 'WooCommerce API keys not configured — Ora Labs order skill limited',
    tasks.find(t => t.id === 't6') && 'Static IP not yet set on server',
  ].filter(Boolean) as string[]

  const plannedToday = [
    ...inProgress.map(t => t.title),
    'Review parallel worker PRs',
    'Verify Telegram bot heartbeat schedule',
  ].slice(0, 5)

  const handleRegen = () => {
    setRegen(true)
    setTimeout(() => setRegen(false), 1200)
  }

  return (
    <div className="p-5 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="text-sm font-semibold text-white">{format(new Date(), 'EEEE, MMMM d')}</div>
          <div className="text-xs text-neutral-500">Auto-generated from task state</div>
        </div>
        <button
          onClick={handleRegen}
          className="btn-ghost flex items-center gap-1.5 text-xs"
        >
          <RefreshCw size={12} className={regenerating ? 'animate-spin' : ''} />
          Regenerate
        </button>
      </div>

      {/* Yesterday */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-3">
          <CheckCircle2 size={15} className="text-emerald-400" />
          <span className="text-sm font-semibold text-white">Yesterday</span>
          <span className="text-xs text-neutral-600">{doneRecently.length} completed</span>
        </div>
        {doneRecently.length > 0 ? (
          <ul className="space-y-1.5">
            {doneRecently.map(t => (
              <li key={t.id} className="flex items-start gap-2 text-sm text-neutral-300">
                <CheckCircle2 size={13} className="text-emerald-400 mt-0.5 shrink-0" />
                {t.title}
                {t.agentId && (
                  <span className="text-[10px] text-neutral-600 ml-auto">
                    {agents.find(a => a.id === t.agentId)?.emoji}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500 italic">No tasks completed yesterday (system just launched)</p>
        )}
      </div>

      {/* Today */}
      <div className="card mb-4">
        <div className="flex items-center gap-2 mb-3">
          <ArrowRight size={15} className="text-blue-400" />
          <span className="text-sm font-semibold text-white">Today</span>
        </div>
        <ul className="space-y-1.5">
          {plannedToday.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-neutral-300">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 shrink-0" />
              {item}
            </li>
          ))}
        </ul>
      </div>

      {/* Review items */}
      {review.length > 0 && (
        <div className="card mb-4">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles size={15} className="text-amber-400" />
            <span className="text-sm font-semibold text-white">Needs Review</span>
          </div>
          <ul className="space-y-1.5">
            {review.map(t => (
              <li key={t.id} className="flex items-start gap-2 text-sm text-neutral-300">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-400 mt-1.5 shrink-0" />
                {t.title}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Blockers */}
      {blockers.length > 0 && (
        <div className="card border-rose-500/20 bg-rose-500/5">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle size={15} className="text-rose-400" />
            <span className="text-sm font-semibold text-white">Blockers</span>
          </div>
          <ul className="space-y-1.5">
            {blockers.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-rose-300">
                <div className="w-1.5 h-1.5 rounded-full bg-rose-400 mt-1.5 shrink-0" />
                {b}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Agent activity */}
      <div className="card mt-4">
        <div className="text-sm font-semibold text-white mb-3">Agent Activity</div>
        <div className="space-y-2">
          {agents.map(a => {
            const aTasks = tasks.filter(t => t.agentId === a.id)
            const aActive = aTasks.filter(t => t.status === 'in_progress')
            return (
              <div key={a.id} className="flex items-center gap-3">
                <span className="text-lg">{a.emoji}</span>
                <div className="flex-1">
                  <div className="text-sm text-white">{a.name}</div>
                  <div className="text-xs text-neutral-500">
                    {aActive.length > 0 ? `Working on: ${aActive[0].title}` : 'Available'}
                  </div>
                </div>
                <div className="text-xs text-neutral-600">{aTasks.length} tasks assigned</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

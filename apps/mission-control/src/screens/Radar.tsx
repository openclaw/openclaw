import { TrendingUp, Cpu, DollarSign, Zap, Activity } from 'lucide-react'
import { useStore } from '../store'

function MiniBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all" style={{ width: `${(value / max) * 100}%`, background: color }} />
    </div>
  )
}

const WEEKS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const MOCK_ACTIVITY = [12, 8, 15, 22, 18, 5, 9]

export function Radar() {
  const { agents, tasks } = useStore()
  const totalCost = agents.reduce((s, a) => s + a.costToday, 0)
  const totalTokens = agents.reduce((s, a) => s + a.tokensUsed, 0)
  const completedTotal = agents.reduce((s, a) => s + a.tasksCompleted, 0)

  return (
    <div className="p-5">
      {/* Summary stats */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        {[
          { icon: DollarSign, label: 'Total Cost Today', value: `$${totalCost.toFixed(2)}`, color: 'text-amber-400' },
          { icon: Cpu, label: 'Total Tokens', value: (totalTokens / 1000).toFixed(0) + 'k', color: 'text-blue-400' },
          { icon: Zap, label: 'Tasks Completed', value: completedTotal, color: 'text-emerald-400' },
          { icon: Activity, label: 'Active Agents', value: agents.filter(a => a.status !== 'idle' && a.status !== 'offline').length, color: 'text-violet-400' },
        ].map(({ icon: Icon, label, value, color }) => (
          <div key={label} className="card flex items-center gap-3">
            <Icon size={16} className={color} />
            <div>
              <div className={`text-xl font-bold ${color}`}>{value}</div>
              <div className="text-xs text-neutral-500">{label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {/* Per-agent cost */}
        <div className="card">
          <div className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <DollarSign size={14} />
            Cost Per Agent — Today
          </div>
          <div className="space-y-3">
            {agents.map(a => (
              <div key={a.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-sm text-neutral-300">
                    <span>{a.emoji}</span>
                    <span>{a.name}</span>
                    <span className="text-[10px] text-neutral-600 font-mono">{a.model.split('/')[1]}</span>
                  </div>
                  <span className="text-sm font-semibold text-amber-400">${a.costToday.toFixed(2)}</span>
                </div>
                <MiniBar value={a.costToday} max={Math.max(...agents.map(x => x.costToday), 1)} color="#f59e0b" />
              </div>
            ))}
          </div>
        </div>

        {/* Tokens per agent */}
        <div className="card">
          <div className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
            <Cpu size={14} />
            Token Usage — All Time
          </div>
          <div className="space-y-3">
            {agents.map(a => (
              <div key={a.id}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2 text-sm text-neutral-300">
                    <span>{a.emoji}</span>
                    <span>{a.name}</span>
                  </div>
                  <span className="text-sm font-semibold text-blue-400">{(a.tokensUsed / 1000).toFixed(0)}k</span>
                </div>
                <MiniBar value={a.tokensUsed} max={Math.max(...agents.map(x => x.tokensUsed), 1)} color="#3b82f6" />
              </div>
            ))}
          </div>
        </div>

        {/* Weekly activity chart */}
        <div className="card">
          <div className="text-sm font-semibold text-white mb-4 flex items-center gap-2">
            <TrendingUp size={14} />
            Task Activity — This Week
          </div>
          <div className="flex items-end gap-2 h-24">
            {WEEKS.map((day, i) => {
              const val = MOCK_ACTIVITY[i]
              const max = Math.max(...MOCK_ACTIVITY)
              return (
                <div key={day} className="flex-1 flex flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t-sm bg-blue-600/60 hover:bg-blue-500/80 transition-colors cursor-default"
                    style={{ height: `${(val / max) * 80}px` }}
                    title={`${val} tasks`}
                  />
                  <span className="text-[9px] text-neutral-600">{day}</span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Task status breakdown */}
        <div className="card">
          <div className="text-sm font-semibold text-white mb-3">Task Breakdown</div>
          {[
            { label: 'Recurring', val: tasks.filter(t => t.status === 'recurring').length, color: '#8b5cf6' },
            { label: 'In Progress', val: tasks.filter(t => t.status === 'in_progress').length, color: '#3b82f6' },
            { label: 'Review', val: tasks.filter(t => t.status === 'review').length, color: '#f59e0b' },
            { label: 'Backlog', val: tasks.filter(t => t.status === 'backlog').length, color: '#6b7280' },
            { label: 'Done', val: tasks.filter(t => t.status === 'done').length, color: '#10b981' },
          ].map(({ label, val, color }) => (
            <div key={label} className="mb-2">
              <div className="flex justify-between text-xs mb-1">
                <span className="text-neutral-400">{label}</span>
                <span className="font-semibold text-white">{val}</span>
              </div>
              <MiniBar value={val} max={tasks.length} color={color} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

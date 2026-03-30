import { useState } from 'react'
import { useStore } from '../store'
import { ChevronLeft, ChevronRight, Clock, Repeat } from 'lucide-react'
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isToday, isSameDay } from 'date-fns'
import clsx from 'clsx'

const JOBS = [
  { id: 'j1', name: 'Morning Market Briefing', cron: '0 7 * * 1-5', color: '#3b82f6', agentEmoji: '🤖', times: ['07:00'], days: [1,2,3,4,5] },
  { id: 'j2', name: 'Morning Tasks Email', cron: '0 7 * * *', color: '#10b981', agentEmoji: '🤖', times: ['07:00'], days: [0,1,2,3,4,5,6] },
  { id: 'j3', name: 'Ora Labs Order Check', cron: '0 9,13,17,21 * * *', color: '#f59e0b', agentEmoji: '🤖', times: ['09:00','13:00','17:00','21:00'], days: [0,1,2,3,4,5,6] },
  { id: 'j4', name: 'System Health Check', cron: '*/30 * * * *', color: '#8b5cf6', agentEmoji: '🤖', times: ['every 30m'], days: [0,1,2,3,4,5,6] },
]

function getJobsForDay(date: Date) {
  const dow = date.getDay()
  return JOBS.filter(j => j.days.includes(dow))
}

export function Calendar() {
  const { tasks } = useStore()
  const [current, setCurrent] = useState(new Date())
  const [selected, setSelected] = useState<Date | null>(new Date())

  const monthStart = startOfMonth(current)
  const monthEnd = endOfMonth(current)
  const days = eachDayOfInterval({ start: monthStart, end: monthEnd })

  // Pad to start on Sunday
  const startPad = monthStart.getDay()
  const paddedDays = Array(startPad).fill(null).concat(days)

  const tasksByDate = tasks.reduce<Record<string, typeof tasks>>((acc, t) => {
    if (t.dueDate) {
      const d = t.dueDate.slice(0, 10)
      if (!acc[d]) acc[d] = []
      acc[d].push(t)
    }
    return acc
  }, {})

  const selectedJobs = selected ? getJobsForDay(selected) : []
  const selectedTasks = selected ? (tasksByDate[format(selected, 'yyyy-MM-dd')] ?? []) : []

  return (
    <div className="p-5 flex gap-5">
      {/* Calendar grid */}
      <div className="flex-1">
        {/* Month header */}
        <div className="flex items-center gap-3 mb-4">
          <button onClick={() => setCurrent(d => new Date(d.getFullYear(), d.getMonth() - 1))} className="btn-ghost p-1.5">
            <ChevronLeft size={14} />
          </button>
          <span className="text-sm font-semibold text-white flex-1 text-center">
            {format(current, 'MMMM yyyy')}
          </span>
          <button onClick={() => setCurrent(d => new Date(d.getFullYear(), d.getMonth() + 1))} className="btn-ghost p-1.5">
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Day headers */}
        <div className="grid grid-cols-7 mb-1">
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d => (
            <div key={d} className="text-center text-[10px] text-neutral-600 py-1">{d}</div>
          ))}
        </div>

        {/* Days */}
        <div className="grid grid-cols-7 gap-1">
          {paddedDays.map((day, i) => {
            if (!day) return <div key={`pad-${i}`} />
            const dayStr = format(day, 'yyyy-MM-dd')
            const dayTasks = tasksByDate[dayStr] ?? []
            const dayJobs = getJobsForDay(day)
            const sel = selected && isSameDay(day, selected)
            const today = isToday(day)
            return (
              <div
                key={dayStr}
                onClick={() => setSelected(day)}
                className={clsx(
                  'min-h-[60px] p-1 rounded-lg cursor-pointer transition-all border',
                  sel ? 'border-blue-500/50 bg-blue-500/10' :
                  today ? 'border-white/[0.1] bg-white/[0.04]' :
                  'border-transparent hover:border-white/[0.06] hover:bg-white/[0.02]'
                )}
              >
                <div className={clsx('text-xs font-medium text-center mb-1 w-5 h-5 flex items-center justify-center rounded-full mx-auto',
                  today ? 'bg-blue-600 text-white' : sel ? 'text-white' : 'text-neutral-500')}>
                  {format(day, 'd')}
                </div>
                {dayJobs.slice(0, 2).map(j => (
                  <div key={j.id} className="h-1 rounded-full mb-0.5" style={{ background: j.color + '88' }} />
                ))}
                {dayTasks.slice(0, 1).map(t => (
                  <div key={t.id} className="text-[9px] text-neutral-400 truncate leading-tight">{t.title}</div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      {/* Day detail panel */}
      <div className="w-72 shrink-0">
        {selected && (
          <div>
            <div className="text-sm font-semibold text-white mb-3">
              {isToday(selected) ? 'Today — ' : ''}{format(selected, 'EEEE, MMM d')}
            </div>

            {/* Scheduled jobs */}
            {selectedJobs.length > 0 && (
              <div className="mb-4">
                <div className="text-xs text-neutral-600 uppercase tracking-widest mb-2">Scheduled Tasks</div>
                <div className="space-y-2">
                  {selectedJobs.map(j => (
                    <div key={j.id} className="card py-2 flex items-center gap-2">
                      <Repeat size={11} style={{ color: j.color }} className="shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-white font-medium truncate">{j.name}</div>
                        <div className="text-[10px] text-neutral-600 flex items-center gap-1">
                          <Clock size={8} />
                          {j.times.join(', ')}
                        </div>
                      </div>
                      <span className="text-sm">{j.agentEmoji}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Tasks due */}
            {selectedTasks.length > 0 && (
              <div>
                <div className="text-xs text-neutral-600 uppercase tracking-widest mb-2">Tasks Due</div>
                <div className="space-y-2">
                  {selectedTasks.map(t => (
                    <div key={t.id} className="card py-2">
                      <div className="text-xs text-white">{t.title}</div>
                      <div className="text-[10px] text-neutral-600 mt-0.5">{t.priority} priority</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedJobs.length === 0 && selectedTasks.length === 0 && (
              <div className="text-xs text-neutral-600 text-center py-8">Nothing scheduled</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

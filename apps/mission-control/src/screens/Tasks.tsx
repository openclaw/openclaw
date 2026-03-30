import { useState } from 'react'
import { useStore } from '../store'
import type { Task, TaskStatus, Priority } from '../types'
import { Plus, Repeat, Clock, User, MoreHorizontal, Flame } from 'lucide-react'
import clsx from 'clsx'

const COLUMNS: { id: TaskStatus; label: string; color: string }[] = [
  { id: 'recurring', label: 'Recurring', color: 'text-violet-400' },
  { id: 'backlog', label: 'Backlog', color: 'text-neutral-400' },
  { id: 'in_progress', label: 'In Progress', color: 'text-blue-400' },
  { id: 'review', label: 'Review', color: 'text-amber-400' },
  { id: 'done', label: 'Done', color: 'text-emerald-400' },
]

const PRIORITY_COLORS: Record<Priority, string> = {
  low: 'bg-neutral-700 text-neutral-300',
  medium: 'bg-blue-900/60 text-blue-300',
  high: 'bg-amber-900/60 text-amber-300',
  critical: 'bg-rose-900/60 text-rose-300',
}

function TaskCard({ task, onMove }: { task: Task; onMove: (id: string, s: TaskStatus) => void }) {
  const { agents } = useStore()
  const agent = agents.find(a => a.id === task.agentId)

  return (
    <div className="card group cursor-grab active:cursor-grabbing hover:border-white/[0.12] transition-all animate-fade-in">
      <div className="flex items-start gap-2 mb-2">
        <span className="flex-1 text-sm text-white leading-snug">{task.title}</span>
        {task.isRecurring && <Repeat size={12} className="text-violet-400 mt-0.5 shrink-0" />}
      </div>

      {task.description && (
        <p className="text-xs text-neutral-500 mb-2 line-clamp-2">{task.description}</p>
      )}

      <div className="flex items-center gap-1.5 flex-wrap mb-2">
        <span className={clsx('badge text-[10px]', PRIORITY_COLORS[task.priority])}>{task.priority}</span>
        {task.tags.slice(0, 2).map(t => (
          <span key={t} className="badge bg-white/[0.06] text-neutral-400 text-[10px]">{t}</span>
        ))}
      </div>

      <div className="flex items-center gap-2 mt-1">
        {agent && (
          <div className="flex items-center gap-1 text-[10px] text-neutral-500">
            <span>{agent.emoji}</span>
            <span>{agent.name}</span>
          </div>
        )}
        {task.streak && task.streak > 0 && (
          <div className="flex items-center gap-0.5 text-[10px] text-amber-400 ml-auto">
            <Flame size={10} />
            <span>{task.streak}</span>
          </div>
        )}
        {task.dueDate && (
          <div className="flex items-center gap-0.5 text-[10px] text-neutral-500 ml-auto">
            <Clock size={10} />
            <span>{new Date(task.dueDate).toLocaleDateString()}</span>
          </div>
        )}
      </div>

      {/* Move buttons on hover */}
      <div className="hidden group-hover:flex gap-1 mt-2 pt-2 border-t border-white/[0.06]">
        {COLUMNS.filter(c => c.id !== task.status).map(c => (
          <button
            key={c.id}
            onClick={() => onMove(task.id, c.id)}
            className={clsx('text-[10px] px-2 py-0.5 rounded-full hover:bg-white/[0.08] transition-colors', c.color)}
          >
            → {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function Tasks() {
  const { tasks, moveTask, addTask } = useStore()
  const [adding, setAdding] = useState<TaskStatus | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const handleAdd = (status: TaskStatus) => {
    if (!newTitle.trim()) return
    addTask({ title: newTitle.trim(), status, priority: 'medium', tags: [] })
    setNewTitle('')
    setAdding(null)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex gap-3 overflow-x-auto p-5 pb-6 min-h-0">
        {COLUMNS.map(col => {
          const colTasks = tasks.filter(t => t.status === col.id)
          return (
            <div key={col.id} className="flex flex-col w-72 shrink-0">
              {/* Column header */}
              <div className="flex items-center gap-2 mb-3 px-1">
                <span className={clsx('text-xs font-semibold', col.color)}>{col.label}</span>
                <span className="text-xs text-neutral-600 bg-white/[0.04] px-1.5 py-0.5 rounded-full">{colTasks.length}</span>
                <button
                  onClick={() => { setAdding(col.id); setNewTitle('') }}
                  className="ml-auto w-5 h-5 flex items-center justify-center rounded text-neutral-600 hover:text-white hover:bg-white/[0.06] transition-colors"
                >
                  <Plus size={12} />
                </button>
              </div>

              {/* Cards */}
              <div className="flex-1 flex flex-col gap-2 overflow-y-auto">
                {adding === col.id && (
                  <div className="card">
                    <input
                      autoFocus
                      className="input text-xs py-1.5"
                      placeholder="Task title…"
                      value={newTitle}
                      onChange={e => setNewTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') handleAdd(col.id)
                        if (e.key === 'Escape') setAdding(null)
                      }}
                    />
                    <div className="flex gap-1 mt-2">
                      <button className="btn-primary text-xs py-1" onClick={() => handleAdd(col.id)}>Add</button>
                      <button className="btn-ghost text-xs py-1" onClick={() => setAdding(null)}>Cancel</button>
                    </div>
                  </div>
                )}
                {colTasks.map(t => (
                  <TaskCard key={t.id} task={t} onMove={moveTask} />
                ))}
                {colTasks.length === 0 && adding !== col.id && (
                  <div className="text-center py-8 text-neutral-700 text-xs">Empty</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

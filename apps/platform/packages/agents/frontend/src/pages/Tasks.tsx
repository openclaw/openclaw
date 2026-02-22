import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../services/api'
import {
  ListTodo,
  RefreshCw,
  Plus,
  Filter,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  X,
} from 'lucide-react'
import { QueryState } from '../components/QueryState'
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

export function TasksPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState<string | undefined>()
  const [showNewTask, setShowNewTask] = useState(false)
  const [newTaskAgent, setNewTaskAgent] = useState('')
  const [newTaskName, setNewTaskName] = useState('')
  const [newTaskType, setNewTaskType] = useState('')
  const [newTaskPriority, setNewTaskPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('medium')
  const modalRef = useRef<HTMLDivElement | null>(null)
  const taskNameInputRef = useRef<HTMLInputElement | null>(null)
  const queryClient = useQueryClient()
  const searchTerm = (searchParams.get('search') || '').trim().toLowerCase()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['tasks', filter],
    queryFn: () => api.getTasks({ status: filter, limit: 100 }),
  })

  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  })

  const createTaskMutation = useMutation({
    mutationFn: (payload: { agent_slug: string; name: string; task_type: string; priority?: string }) =>
      api.createTask(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      setShowNewTask(false)
      setNewTaskName('')
      setNewTaskType('')
      setNewTaskAgent('')
      setNewTaskPriority('medium')
    },
  })

  const tasks = data?.tasks || []
  const agents = agentsData?.agents || []
  const filteredTasks = useMemo(() => {
    if (!searchTerm) {return tasks}
    return tasks.filter(
      (task) =>
        task.name.toLowerCase().includes(searchTerm) ||
        task.task_type.toLowerCase().includes(searchTerm)
    )
  }, [tasks, searchTerm])

  useEffect(() => {
    if (!showNewTask) {return}

    const previousActive = document.activeElement as HTMLElement | null
    taskNameInputRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowNewTask(false)
        return
      }

      if (event.key !== 'Tab' || !modalRef.current) {return}

      const focusable = Array.from(
        modalRef.current.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => !element.hasAttribute('disabled'))

      if (focusable.length === 0) {return}

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = document.activeElement as HTMLElement | null

      if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previousActive?.focus()
    }
  }, [showNewTask])

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="w-4 h-4 text-green-400" />
      case 'failed':
        return <XCircle className="w-4 h-4 text-red-400" />
      case 'running':
        return <RefreshCw className="w-4 h-4 text-primary-400 animate-spin" />
      case 'pending':
        return <Clock className="w-4 h-4 text-yellow-400" />
      default:
        return <AlertCircle className="w-4 h-4 text-surface-400" />
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Tasks</h1>
          <p className="text-surface-400 mt-1">
            View and manage agent tasks
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="btn-secondary">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => setShowNewTask(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Task
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-4 h-4 text-surface-400" aria-hidden />
        {['all', 'pending', 'running', 'completed', 'failed'].map(status => (
          <button
            key={status}
            onClick={() => setFilter(status === 'all' ? undefined : status)}
            className={clsx(
              'badge cursor-pointer transition-colors',
              (filter === status || (status === 'all' && !filter))
                ? 'badge-info'
                : 'badge-neutral hover:bg-surface-700'
            )}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
        {filter && (
          <button
            onClick={() => setFilter(undefined)}
            className="text-xs text-surface-400 hover:text-surface-200"
          >
            Clear filters
          </button>
        )}
        {searchTerm && (
          <button
            onClick={() => {
              const nextParams = new URLSearchParams(searchParams)
              nextParams.delete('search')
              setSearchParams(nextParams)
            }}
            className="text-xs text-primary-400 hover:text-primary-300"
          >
            Clear search: "{searchParams.get('search')}"
          </button>
        )}
      </div>

      {/* New Task modal */}
      {showNewTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowNewTask(false)
            }
          }}
        >
          <div
            ref={modalRef}
            className="card max-w-md w-full shadow-xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-task-title"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 id="new-task-title" className="text-lg font-bold">New Task</h2>
              <button
                onClick={() => setShowNewTask(false)}
                className="btn-icon-sm"
                aria-label="Close new task dialog"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (!newTaskAgent || !newTaskName || !newTaskType) {return}
                createTaskMutation.mutate({
                  agent_slug: newTaskAgent,
                  name: newTaskName,
                  task_type: newTaskType,
                  priority: newTaskPriority,
                })
              }}
              className="space-y-4"
            >
              <div>
                <label htmlFor="new-task-agent" className="block text-sm font-medium text-surface-400 mb-1">Agent</label>
                <select
                  id="new-task-agent"
                  value={newTaskAgent}
                  onChange={(e) => setNewTaskAgent(e.target.value)}
                  className="input"
                  required
                >
                  <option value="">Select agent</option>
                  {agents.map((a) => (
                    <option key={a.slug} value={a.slug}>{a.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="new-task-name" className="block text-sm font-medium text-surface-400 mb-1">Task name</label>
                <input
                  id="new-task-name"
                  ref={taskNameInputRef}
                  type="text"
                  value={newTaskName}
                  onChange={(e) => setNewTaskName(e.target.value)}
                  className="input"
                  placeholder="e.g. Daily report"
                  required
                />
              </div>
              <div>
                <label htmlFor="new-task-type" className="block text-sm font-medium text-surface-400 mb-1">Task type</label>
                <input
                  id="new-task-type"
                  type="text"
                  value={newTaskType}
                  onChange={(e) => setNewTaskType(e.target.value)}
                  className="input font-mono"
                  placeholder="e.g. generate_report, check_repository"
                />
              </div>
              <div>
                <label htmlFor="new-task-priority" className="block text-sm font-medium text-surface-400 mb-1">Priority</label>
                <select
                  id="new-task-priority"
                  value={newTaskPriority}
                  onChange={(e) => setNewTaskPriority(e.target.value as any)}
                  className="input"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowNewTask(false)} className="btn-ghost">
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createTaskMutation.isPending || !newTaskAgent || !newTaskName || !newTaskType}
                  className="btn-primary"
                >
                  {createTaskMutation.isPending ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </form>
            {createTaskMutation.isError && (
              <p className="mt-2 text-sm text-red-400">
                {(createTaskMutation.error as Error).message}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Task list */}
      <div className="card">
        <QueryState
          isLoading={isLoading}
          error={error as Error | null}
          empty={!isLoading && !error && filteredTasks.length === 0}
          emptyIcon={<ListTodo className="w-12 h-12 opacity-50" />}
          emptyTitle="No tasks found"
          emptyDescription="Create a task from the button above or wait for scheduled runs."
          onRetry={() => refetch()}
        >
          <>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Duration</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {filteredTasks.map(task => (
                  <tr key={task.id} className="cursor-pointer">
                    <td className="font-medium flex items-center gap-2">
                      {statusIcon(task.status)}
                      {task.name}
                    </td>
                    <td className="font-mono text-sm">{task.task_type}</td>
                    <td>
                      <span className={clsx(
                        'badge',
                        task.status === 'completed' ? 'badge-success' :
                        task.status === 'failed' ? 'badge-error' :
                        task.status === 'running' ? 'badge-info' : 'badge-warning'
                      )}>
                        {task.status}
                      </span>
                    </td>
                    <td>
                      <span className={clsx(
                        'badge',
                        task.priority === 'critical' ? 'badge-error' :
                        task.priority === 'high' ? 'badge-warning' : 'badge-neutral'
                      )}>
                        {task.priority}
                      </span>
                    </td>
                    <td>{task.execution_time ? `${task.execution_time.toFixed(1)}s` : '-'}</td>
                    <td className="text-surface-400">
                      {new Date(task.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        </QueryState>
      </div>
    </div>
  )
}

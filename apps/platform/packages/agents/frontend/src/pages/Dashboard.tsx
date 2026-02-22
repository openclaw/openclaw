import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'
import {
  Bot,
  ListTodo,
  Activity,
  AlertTriangle,
  TrendingUp,
  Clock,
  CheckCircle,
  XCircle,
  Play,
  RefreshCw,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'

interface StatCardProps {
  title: string
  value: string | number
  icon: React.ElementType
  trend?: { value: number; positive: boolean; label?: string }
  color: string
}

function StatCard({ title, value, icon: Icon, trend, color }: StatCardProps) {
  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-surface-400">{title}</p>
          <p className="text-2xl font-bold mt-1">{value}</p>
          {trend && (
            <p className={clsx(
              'text-sm mt-1 flex items-center gap-1',
              trend.positive ? 'text-green-400' : 'text-red-400'
            )}>
              <TrendingUp className={clsx('w-3 h-3', !trend.positive && 'rotate-180')} />
              {trend.value}% {trend.label || 'change'}
            </p>
          )}
        </div>
        <div className={clsx('p-3 rounded-lg', color)}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
    </div>
  )
}

interface AgentCardProps {
  agent: {
    name: string
    slug: string
    status: string
    is_running: boolean
    last_run_at?: string
    successful_runs: number
    failed_runs: number
  }
  onRun: () => void
}

function AgentCard({ agent, onRun }: AgentCardProps) {
  const successRate = agent.successful_runs + agent.failed_runs > 0
    ? Math.round((agent.successful_runs / (agent.successful_runs + agent.failed_runs)) * 100)
    : 100

  return (
    <div className="card hover:border-surface-700 transition-colors">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className={clsx(
            'w-10 h-10 rounded-lg flex items-center justify-center',
            agent.is_running ? 'bg-green-500/20' : 'bg-surface-800'
          )}>
            <Bot className={clsx(
              'w-5 h-5',
              agent.is_running ? 'text-green-400' : 'text-surface-400'
            )} />
          </div>
          <div>
            <h3 className="font-medium text-surface-100">{agent.name}</h3>
            <p className="text-xs text-surface-500">{agent.slug}</p>
          </div>
        </div>
        <div className={clsx(
          'status-dot',
          agent.is_running ? 'status-dot-success' : 
          agent.status === 'error' ? 'status-dot-error' : 'status-dot-idle'
        )} />
      </div>

      <div className="flex items-center justify-between text-sm mb-3">
        <span className="text-surface-400">Success Rate</span>
        <span className={clsx(
          successRate >= 90 ? 'text-green-400' :
          successRate >= 70 ? 'text-yellow-400' : 'text-red-400'
        )}>
          {successRate}%
        </span>
      </div>

      <div className="h-2 bg-surface-800 rounded-full overflow-hidden mb-3">
        <div
          className={clsx(
            'h-full transition-all',
            successRate >= 90 ? 'bg-green-500' :
            successRate >= 70 ? 'bg-yellow-500' : 'bg-red-500'
          )}
          style={{ width: `${successRate}%` }}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="text-xs text-surface-500 flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {agent.last_run_at 
            ? new Date(agent.last_run_at).toLocaleTimeString()
            : 'Never run'}
        </div>
        <button
          onClick={onRun}
          disabled={agent.is_running}
          className={clsx(
            'btn-icon text-surface-400 hover:text-primary-400',
            agent.is_running && 'animate-spin text-primary-400'
          )}
        >
          {agent.is_running ? <RefreshCw className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
      </div>
    </div>
  )
}

export function Dashboard() {
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: api.getStatus,
    refetchInterval: 10000,
  })

  const { data: agentsData, isLoading: agentsLoading, error: agentsError, refetch: refetchAgents } = useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  })

  const { data: tasksData } = useQuery({
    queryKey: ['tasks', 'recent'],
    queryFn: () => api.getTasks({ limit: 250 }),
  })

  const { data: activityData } = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.getActivity(250),
  })

  const handleRunAgent = async (slug: string) => {
    await api.runAgent(slug)
    refetchAgents()
  }

  const agents = agentsData?.agents || []
  const tasks = tasksData?.tasks || []
  const activity = activityData?.activity || []
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startYesterday = new Date(startToday)
  startYesterday.setDate(startYesterday.getDate() - 1)

  const runningAgents = agents.filter(a => a.is_running).length
  const pendingTasks = status?.pending_tasks || 0
  const completedToday = tasks.filter((task) => {
    if (task.status !== 'completed' || !task.completed_at) {return false}
    const completedAt = new Date(task.completed_at)
    return completedAt >= startToday
  }).length
  const completedYesterday = tasks.filter((task) => {
    if (task.status !== 'completed' || !task.completed_at) {return false}
    const completedAt = new Date(task.completed_at)
    return completedAt >= startYesterday && completedAt < startToday
  }).length
  const completionTrend =
    completedYesterday === 0
      ? completedToday > 0
        ? { value: 100, positive: true, label: 'vs yesterday' as const }
        : undefined
      : {
          value: Math.abs(Math.round(((completedToday - completedYesterday) / completedYesterday) * 100)),
          positive: completedToday >= completedYesterday,
          label: 'vs yesterday' as const,
        }
  const alertsLast24h = activity.filter((item: any) => {
    if (!item?.timestamp || !item?.level) {return false}
    const level = String(item.level).toUpperCase()
    if (level !== 'ERROR' && level !== 'WARNING') {return false}
    const timestamp = new Date(item.timestamp)
    return timestamp.getTime() >= now.getTime() - 24 * 60 * 60 * 1000
  }).length

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <p className="text-surface-400 mt-1">
          Monitor your agents and business operations
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="Active Agents"
          value={`${runningAgents} / ${agents.length}`}
          icon={Bot}
          color="bg-primary-500"
        />
        <StatCard
          title="Pending Tasks"
          value={pendingTasks}
          icon={ListTodo}
          color="bg-accent-500"
        />
        <StatCard
          title="Completed Today"
          value={completedToday}
          icon={CheckCircle}
          trend={completionTrend}
          color="bg-green-500"
        />
        <StatCard
          title="Alerts (24h)"
          value={alertsLast24h}
          icon={AlertTriangle}
          color="bg-yellow-500"
        />
      </div>

      {/* Main content grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents section */}
        <div className="lg:col-span-2">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Agents</h2>
              <Link to="/agents" className="text-sm text-primary-400 hover:text-primary-300">
                View all →
              </Link>
            </div>
            
            {agentsError ? (
              <div className="py-8 px-4 text-center">
                <p className="text-sm text-red-400 mb-2">Failed to load agents</p>
                <button onClick={() => refetchAgents()} className="btn-ghost text-sm flex items-center gap-1 mx-auto">
                  <RefreshCw className="w-4 h-4" /> Retry
                </button>
              </div>
            ) : agentsLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-6 h-6 animate-spin text-surface-400" />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {agents.slice(0, 4).map(agent => (
                  <AgentCard
                    key={agent.slug}
                    agent={agent}
                    onRun={() => handleRunAgent(agent.slug)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Activity feed */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Recent Activity</h2>
            <Link to="/activity" className="text-sm text-primary-400 hover:text-primary-300">
              View all →
            </Link>
          </div>
          
          <div className="space-y-3">
            {activity.length === 0 ? (
              <p className="text-surface-500 text-sm text-center py-8">
                No recent activity
              </p>
            ) : (
              activity.map((item: any, index: number) => (
                <div key={index} className="flex items-start gap-3 py-2 border-b border-surface-800 last:border-0">
                  <div className={clsx(
                    'w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0',
                    item.level === 'ERROR' ? 'bg-red-500/20' :
                    item.level === 'WARNING' ? 'bg-yellow-500/20' : 'bg-surface-800'
                  )}>
                    {item.level === 'ERROR' ? (
                      <XCircle className="w-4 h-4 text-red-400" />
                    ) : item.level === 'WARNING' ? (
                      <AlertTriangle className="w-4 h-4 text-yellow-400" />
                    ) : (
                      <Activity className="w-4 h-4 text-surface-400" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-surface-200 truncate">{item.message}</p>
                    <p className="text-xs text-surface-500">
                      {new Date(item.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Recent tasks */}
      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Recent Tasks</h2>
          <Link to="/tasks" className="text-sm text-primary-400 hover:text-primary-300">
            View all →
          </Link>
        </div>
        
        {tasks.length === 0 ? (
          <p className="text-surface-500 text-sm text-center py-8">
            No recent tasks
          </p>
        ) : (
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
                {tasks.slice(0, 5).map(task => (
                  <tr key={task.id}>
                    <td className="font-medium">{task.name}</td>
                    <td>{task.task_type}</td>
                    <td>
                      <span className={clsx(
                        'badge',
                        task.status === 'completed' ? 'badge-success' :
                        task.status === 'failed' ? 'badge-error' :
                        task.status === 'running' ? 'badge-info' : 'badge-neutral'
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
                    <td>{new Date(task.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

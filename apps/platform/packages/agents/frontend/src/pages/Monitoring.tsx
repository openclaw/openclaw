import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'
import {
  Activity,
  Bot,
  CheckCircle,
  XCircle,
  Clock,
  AlertTriangle,
  RefreshCw,
  BarChart3,
} from 'lucide-react'
import clsx from 'clsx'
import { QueryState } from '../components/QueryState'

export function Monitoring() {
  const { data: summary, isLoading: summaryLoading, error: summaryError, refetch: refetchSummary } = useQuery({
    queryKey: ['observability', 'summary'],
    queryFn: api.getObservabilitySummary,
    refetchInterval: 15000,
  })

  const { data: metrics, isLoading: metricsLoading, error: metricsError, refetch: refetchMetrics } = useQuery({
    queryKey: ['metrics'],
    queryFn: api.getMetrics,
    refetchInterval: 15000,
  })

  const isLoading = summaryLoading || metricsLoading
  const error = summaryError || metricsError

  const refreshAll = async () => {
    await Promise.all([refetchSummary(), refetchMetrics()])
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Monitoring</h1>
        <p className="text-surface-400 mt-1">
          Observability, metrics, and agent health at a glance
        </p>
      </div>

      <QueryState
        isLoading={isLoading}
        error={error as Error | null}
        empty={false}
        onRetry={refreshAll}
      >
        <>
          {/* Metrics cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4">
            <MetricCard
              title="Agents"
              value={metrics ? `${metrics.agents_enabled}/${metrics.agents_total}` : '–'}
              icon={Bot}
              color="bg-primary-500"
            />
            <MetricCard
              title="Runs (total)"
              value={metrics?.task_runs_total ?? '–'}
              icon={BarChart3}
              color="bg-surface-600"
            />
            <MetricCard
              title="Success"
              value={metrics?.task_runs_successful ?? '–'}
              icon={CheckCircle}
              color="bg-green-500"
            />
            <MetricCard
              title="Failed"
              value={metrics?.task_runs_failed ?? '–'}
              icon={XCircle}
              color="bg-red-500"
            />
            <MetricCard
              title="Pending"
              value={metrics?.tasks_pending ?? '–'}
              icon={Clock}
              color="bg-yellow-500"
            />
            <MetricCard
              title="Running"
              value={metrics?.tasks_running ?? '–'}
              icon={Activity}
              color="bg-accent-500"
            />
            <MetricCard
              title="Failed (24h)"
              value={summary?.tasks.failed_last_24h ?? '–'}
              icon={AlertTriangle}
              color="bg-amber-500"
            />
          </div>

          {/* Agent health table */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">Agent health</h2>
              <button
                onClick={refreshAll}
                className="btn-ghost text-sm flex items-center gap-1"
                aria-label="Refresh monitoring data"
              >
                <RefreshCw className="w-4 h-4" /> Refresh
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Status</th>
                    <th>Runs</th>
                    <th>Success</th>
                    <th>Failed</th>
                    <th>Last run</th>
                    <th>Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.agents ?? []).map((a) => (
                    <tr key={a.slug}>
                      <td className="font-medium">{a.name}</td>
                      <td>
                        <span className={clsx(
                          'badge',
                          a.is_running ? 'badge-info' :
                          a.status === 'error' ? 'badge-error' : 'badge-neutral'
                        )}>
                          {a.is_running ? 'Running' : a.status}
                        </span>
                      </td>
                      <td>{a.total_runs}</td>
                      <td className="text-green-400">{a.successful_runs}</td>
                      <td className="text-red-400">{a.failed_runs}</td>
                      <td className="text-surface-400">
                        {a.last_run_at ? new Date(a.last_run_at).toLocaleString() : '–'}
                      </td>
                      <td className="text-surface-400 max-w-xs truncate" title={a.last_error ?? ''}>
                        {a.last_error ?? '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary && !summary.orchestrator_running && (
              <p className="mt-3 text-sm text-amber-400">Orchestrator is not running.</p>
            )}
          </div>
        </>
      </QueryState>
    </div>
  )
}

function MetricCard({
  title,
  value,
  icon: Icon,
  color,
}: {
  title: string
  value: string | number
  icon: React.ElementType
  color: string
}) {
  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs text-surface-500 uppercase tracking-wide">{title}</p>
          <p className="text-xl font-bold mt-1">{value}</p>
        </div>
        <div className={clsx('p-2 rounded-lg', color)}>
          <Icon className="w-5 h-5 text-white" />
        </div>
      </div>
    </div>
  )
}

import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'
import {
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Info,
  Filter,
} from 'lucide-react'
import clsx from 'clsx'
import { useState } from 'react'
import { QueryState } from '../components/QueryState'

export function ActivityPage() {
  const [levelFilter, setLevelFilter] = useState<string | undefined>()
  
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['logs', levelFilter],
    queryFn: () => api.getLogs({ level: levelFilter, limit: 100 }),
    refetchInterval: 10000,
  })

  const logs = data?.logs || []

  const levelIcon = (level: string) => {
    switch (level) {
      case 'ERROR':
        return <XCircle className="w-4 h-4 text-red-400" />
      case 'WARNING':
        return <AlertTriangle className="w-4 h-4 text-yellow-400" />
      case 'INFO':
        return <Info className="w-4 h-4 text-primary-400" />
      default:
        return <CheckCircle className="w-4 h-4 text-green-400" />
    }
  }

  const levelColor = (level: string) => {
    switch (level) {
      case 'ERROR':
        return 'border-l-red-500 bg-red-500/5'
      case 'WARNING':
        return 'border-l-yellow-500 bg-yellow-500/5'
      case 'INFO':
        return 'border-l-primary-500 bg-primary-500/5'
      default:
        return 'border-l-green-500 bg-green-500/5'
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Activity Log</h1>
          <p className="text-surface-400 mt-1">
            Monitor agent activity and system events
          </p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <Filter className="w-4 h-4 text-surface-400" aria-hidden />
        {['all', 'ERROR', 'WARNING', 'INFO', 'DEBUG'].map(level => (
          <button
            key={level}
            onClick={() => setLevelFilter(level === 'all' ? undefined : level)}
            className={clsx(
              'badge cursor-pointer transition-colors',
              (levelFilter === level || (level === 'all' && !levelFilter))
                ? level === 'ERROR' ? 'badge-error' :
                  level === 'WARNING' ? 'badge-warning' :
                  level === 'INFO' ? 'badge-info' : 'badge-success'
                : 'badge-neutral hover:bg-surface-700'
            )}
          >
            {level === 'all' ? 'All' : level}
          </button>
        ))}
        {levelFilter && (
          <button
            onClick={() => setLevelFilter(undefined)}
            className="text-xs text-surface-400 hover:text-surface-200"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Log entries */}
      <div className="space-y-2">
        <QueryState
          isLoading={isLoading}
          error={error as Error | null}
          empty={!isLoading && !error && logs.length === 0}
          emptyIcon={<Activity className="w-12 h-12 opacity-50" />}
          emptyTitle="No activity recorded"
          emptyDescription="Agent logs will appear here when agents run."
          onRetry={() => refetch()}
        >
          <>
          {logs.map((log: any) => (
            <div
              key={log.id}
              className={clsx(
                'rounded-lg border-l-4 p-4 transition-colors hover:bg-surface-800/50',
                levelColor(log.level)
              )}
            >
              <div className="flex items-start gap-3">
                {levelIcon(log.level)}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className={clsx(
                      'text-xs font-medium',
                      log.level === 'ERROR' ? 'text-red-400' :
                      log.level === 'WARNING' ? 'text-yellow-400' :
                      log.level === 'INFO' ? 'text-primary-400' : 'text-green-400'
                    )}>
                      {log.level}
                    </span>
                    <span className="text-xs text-surface-500">
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-surface-200 mt-1">{log.message}</p>
                  {log.details && (
                    <pre className="mt-2 text-xs text-surface-400 bg-surface-900 rounded p-2 overflow-x-auto">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          ))}
          </>
        </QueryState>
      </div>
    </div>
  )
}

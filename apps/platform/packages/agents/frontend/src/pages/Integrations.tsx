import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../services/api'
import {
  Plug,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  Plus,
} from 'lucide-react'
import clsx from 'clsx'
import { QueryState } from '../components/QueryState'

const integrationIcons: Record<string, string> = {
  stripe: '💳',
  github: '🐙',
  gmail: '📧',
  notion: '📝',
  telegram: '✈️',
  slack: '💬',
  calendar: '📅',
  banking: '🏦',
}

export function IntegrationsPage() {
  const queryClient = useQueryClient()

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['integrations'],
    queryFn: api.getIntegrations,
  })

  const checkHealthMutation = useMutation({
    mutationFn: (slug: string) => api.checkIntegrationHealth(slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['integrations'] })
    },
  })

  const integrations = data?.integrations || []
  const checkingSlug = checkHealthMutation.isPending ? checkHealthMutation.variables : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Integrations</h1>
          <p className="text-surface-400 mt-1">
            Connect external services to your agents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => refetch()} className="btn-secondary">
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            className="btn-primary flex items-center gap-2 opacity-60 cursor-not-allowed"
            disabled
            aria-disabled="true"
            title="Self-serve integration setup is coming soon."
          >
            <Plus className="w-4 h-4" />
            Add Integration (Soon)
          </button>
        </div>
      </div>

      {checkHealthMutation.isError && (
        <div className="card border-red-500/40 bg-red-500/10 text-sm text-red-300">
          Failed to run health check: {(checkHealthMutation.error as Error).message}
        </div>
      )}

      <QueryState
        isLoading={isLoading}
        error={error as Error | null}
        empty={!isLoading && !error && integrations.length === 0}
        emptyIcon={<Plug className="w-12 h-12 opacity-50" />}
        emptyTitle="No integrations configured"
        emptyDescription="Add an integration to connect external services."
        onRetry={() => refetch()}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {integrations.map(integration => (
            <div key={integration.id} className="card hover:border-surface-700 transition-colors">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-surface-800 flex items-center justify-center text-2xl">
                    {integrationIcons[integration.service_type] || '🔌'}
                  </div>
                  <div>
                    <h3 className="font-medium">{integration.name}</h3>
                    <p className="text-xs text-surface-500">{integration.service_type}</p>
                  </div>
                </div>
                <button
                  className="btn-icon"
                  onClick={() => checkHealthMutation.mutate(integration.slug)}
                  disabled={checkHealthMutation.isPending}
                  aria-label={`Check health for ${integration.name}`}
                  title="Check health"
                >
                  <RefreshCw
                    className={clsx(
                      'w-4 h-4 text-surface-400',
                      checkingSlug === integration.slug && 'animate-spin text-primary-400'
                    )}
                  />
                </button>
              </div>

              <div className="flex items-center justify-between mb-4">
                <span className="text-surface-400 text-sm">Status</span>
                <span className={clsx(
                  'badge flex items-center gap-1',
                  integration.status === 'connected' ? 'badge-success' :
                  integration.status === 'error' ? 'badge-error' : 'badge-warning'
                )}>
                  {integration.status === 'connected' ? (
                    <CheckCircle className="w-3 h-3" />
                  ) : integration.status === 'error' ? (
                    <XCircle className="w-3 h-3" />
                  ) : (
                    <AlertCircle className="w-3 h-3" />
                  )}
                  {integration.status}
                </span>
              </div>

              {integration.error_message && (
                <div className="text-xs text-red-400 bg-red-500/10 rounded-lg p-2 mb-4">
                  {integration.error_message}
                </div>
              )}

              <div className="text-xs text-surface-500 flex items-center justify-between gap-2">
                <span>
                  Last checked: {integration.last_health_check
                    ? new Date(integration.last_health_check).toLocaleString()
                    : 'Never'}
                </span>
                <button
                  className="text-primary-400 hover:text-primary-300"
                  onClick={() => checkHealthMutation.mutate(integration.slug)}
                  disabled={checkHealthMutation.isPending}
                >
                  Check now
                </button>
              </div>
            </div>
          ))}
        </div>
      </QueryState>

      {/* Available integrations */}
      <div className="card mt-8">
        <h2 className="card-title mb-4">Available Integrations</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
          {[
            { name: 'Stripe', icon: '💳', desc: 'Payments' },
            { name: 'GitHub', icon: '🐙', desc: 'Code & CI/CD' },
            { name: 'Gmail', icon: '📧', desc: 'Email' },
            { name: 'Notion', icon: '📝', desc: 'Docs & Wiki' },
            { name: 'Telegram', icon: '✈️', desc: 'Messaging' },
            { name: 'Calendar', icon: '📅', desc: 'Scheduling' },
          ].map(item => (
            <button
              key={item.name}
              className="p-4 rounded-xl border border-surface-800 opacity-60 cursor-not-allowed text-center"
              disabled
              aria-disabled="true"
              title="Install/configure flow is coming soon."
            >
              <div className="text-3xl mb-2">{item.icon}</div>
              <div className="font-medium text-sm">{item.name}</div>
              <div className="text-xs text-surface-500">{item.desc}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

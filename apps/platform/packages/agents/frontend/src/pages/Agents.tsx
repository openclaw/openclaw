import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api, Agent } from '../services/api'
import {
  Bot,
  Play,
  RefreshCw,
  ChevronRight,
} from 'lucide-react'
import clsx from 'clsx'

function AgentDetailPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient()
  
  const runMutation = useMutation({
    mutationFn: () => api.runAgent(agent.slug),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: () => api.updateAgent(agent.slug, { is_enabled: !agent.is_enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  const successRate = agent.successful_runs + agent.failed_runs > 0
    ? Math.round((agent.successful_runs / (agent.successful_runs + agent.failed_runs)) * 100)
    : 100

  return (
    <div className="card">
      {/* Header */}
      <div className="flex items-start justify-between pb-4 border-b border-surface-800">
        <div className="flex items-center gap-4">
          <div className={clsx(
            'w-14 h-14 rounded-xl flex items-center justify-center',
            agent.is_running ? 'bg-green-500/20' : 'bg-surface-800'
          )}>
            <Bot className={clsx(
              'w-7 h-7',
              agent.is_running ? 'text-green-400' : 'text-surface-400'
            )} />
          </div>
          <div>
            <h2 className="text-xl font-bold">{agent.name}</h2>
            <p className="text-surface-400 text-sm">{agent.agent_type} agent</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => toggleMutation.mutate()}
            className={clsx(
              'btn-secondary',
              !agent.is_enabled && 'opacity-50'
            )}
          >
            {agent.is_enabled ? 'Enabled' : 'Disabled'}
          </button>
          <button
            onClick={() => runMutation.mutate()}
            disabled={!agent.is_enabled || agent.is_running}
            className="btn-primary flex items-center gap-2"
          >
            {runMutation.isPending || agent.is_running ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Run Now
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 py-4 border-b border-surface-800">
        <div>
          <p className="text-sm text-surface-400">Total Runs</p>
          <p className="text-2xl font-bold">{agent.total_runs}</p>
        </div>
        <div>
          <p className="text-sm text-surface-400">Successful</p>
          <p className="text-2xl font-bold text-green-400">{agent.successful_runs}</p>
        </div>
        <div>
          <p className="text-sm text-surface-400">Failed</p>
          <p className="text-2xl font-bold text-red-400">{agent.failed_runs}</p>
        </div>
        <div>
          <p className="text-sm text-surface-400">Success Rate</p>
          <p className={clsx(
            'text-2xl font-bold',
            successRate >= 90 ? 'text-green-400' :
            successRate >= 70 ? 'text-yellow-400' : 'text-red-400'
          )}>
            {successRate}%
          </p>
        </div>
      </div>

      {/* Details */}
      <div className="py-4 space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-surface-400">Status</span>
          <span className={clsx(
            'badge',
            agent.is_running ? 'badge-success' :
            agent.status === 'error' ? 'badge-error' : 'badge-neutral'
          )}>
            {agent.is_running ? 'Running' : agent.status}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-surface-400">Schedule (cron)</span>
          <span className="font-mono text-sm truncate" title={agent.schedule || 'Not set'}>
            {agent.schedule || 'Manual'}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-surface-400">Last Run</span>
          <span>{agent.last_run_at ? new Date(agent.last_run_at).toLocaleString() : 'Never'}</span>
        </div>
      </div>

      {/* Capabilities */}
      {agent.capabilities && agent.capabilities.length > 0 && (
        <div className="pt-4 border-t border-surface-800">
          <h3 className="text-sm font-medium text-surface-400 mb-3">Capabilities</h3>
          <div className="flex flex-wrap gap-2">
            {agent.capabilities.map(cap => (
              <span key={cap} className="badge badge-info">{cap}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export function AgentsPage() {
  const { agentSlug } = useParams()
  
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['agents'],
    queryFn: api.getAgents,
  })

  const agents = data?.agents || []
  const selectedAgent = agentSlug ? agents.find(a => a.slug === agentSlug) : null

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <RefreshCw className="w-8 h-8 animate-spin text-surface-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Agents</h1>
          <p className="text-surface-400 mt-1">
            Manage and monitor your AI agents
          </p>
        </div>
        <button onClick={() => refetch()} className="btn-secondary">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent list */}
        <div className="space-y-3">
          {agents.map(agent => (
            <Link
              key={agent.slug}
              to={`/agents/${agent.slug}`}
              className={clsx(
                'card flex items-center justify-between cursor-pointer hover:border-surface-700 transition-colors',
                selectedAgent?.slug === agent.slug && 'border-primary-500 bg-primary-500/5'
              )}
            >
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
                  <h3 className="font-medium">{agent.name}</h3>
                  <p className="text-xs text-surface-500">{agent.agent_type}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className={clsx(
                  'status-dot',
                  agent.is_running ? 'status-dot-success' :
                  agent.status === 'error' ? 'status-dot-error' : 'status-dot-idle'
                )} />
                <ChevronRight className="w-4 h-4 text-surface-500" />
              </div>
            </Link>
          ))}
        </div>

        {/* Agent detail */}
        <div className="lg:col-span-2">
          {selectedAgent ? (
            <AgentDetailPanel agent={selectedAgent} />
          ) : (
            <div className="card flex flex-col items-center justify-center py-20 text-surface-400">
              <Bot className="w-12 h-12 mb-4 opacity-50" />
              <p>Select an agent to view details</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

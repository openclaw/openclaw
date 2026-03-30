import { useQuery } from '@tanstack/react-query'
import { getGatewayHealth, getConfig, getLogs } from '../api/openclaw'
import { Server, Activity, HardDrive, Cpu, Wifi, WifiOff, Terminal, RefreshCw } from 'lucide-react'
import clsx from 'clsx'

function StatCard({ icon: Icon, label, value, sub, color = 'text-white' }: {
  icon: any; label: string; value: string | number; sub?: string; color?: string
}) {
  return (
    <div className="card flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-white/[0.04] flex items-center justify-center">
        <Icon size={16} className={color} />
      </div>
      <div>
        <div className={clsx('text-lg font-semibold', color)}>{value}</div>
        <div className="text-xs text-neutral-500">{label}</div>
        {sub && <div className="text-[10px] text-neutral-600">{sub}</div>}
      </div>
    </div>
  )
}

export function System() {
  const { data: health, refetch: refetchHealth, isFetching: healthFetching } = useQuery({
    queryKey: ['gateway-health'],
    queryFn: getGatewayHealth,
    refetchInterval: 15_000,
  })
  const { data: config } = useQuery({ queryKey: ['openclaw-config'], queryFn: getConfig, staleTime: 60_000 })
  const { data: logs, refetch: refetchLogs } = useQuery({ queryKey: ['logs'], queryFn: getLogs, staleTime: 30_000 })

  const online = health?.online ?? false

  return (
    <div className="p-5">
      {/* Status grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
        <StatCard
          icon={online ? Wifi : WifiOff}
          label="Gateway"
          value={online ? 'Online' : 'Offline'}
          sub={`Port ${health?.port ?? 18789}`}
          color={online ? 'text-emerald-400' : 'text-neutral-500'}
        />
        <StatCard icon={Server} label="Model" value="gpt-4o-mini" sub="OpenAI" color="text-blue-400" />
        <StatCard icon={Cpu} label="Server" value="i5-12400" sub="Acer Aspire TC-1760" color="text-violet-400" />
        <StatCard icon={HardDrive} label="RAM" value="12 GB" sub="~1.7 GB free w/ miners" color="text-amber-400" />
      </div>

      {/* Config viewer */}
      <div className="card mb-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Activity size={14} />
            Live Config — ~/.openclaw/openclaw.json
          </div>
        </div>
        {config ? (
          <pre className="text-xs font-mono text-neutral-300 bg-black/30 rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto">
            {JSON.stringify(config, (k, v) => {
              // Redact sensitive values
              if (['token', 'botToken', 'key'].includes(k) && typeof v === 'string') return v.slice(0, 8) + '…'
              if (k === 'allowFrom') return v
              return v
            }, 2)}
          </pre>
        ) : (
          <div className="text-xs text-neutral-600 py-4 text-center">
            Config not accessible in this environment
          </div>
        )}
      </div>

      {/* Gateway logs */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Terminal size={14} />
            Gateway Logs
          </div>
          <button
            onClick={() => refetchLogs()}
            className="btn-ghost text-xs flex items-center gap-1"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>
        <div className="bg-black/40 rounded-lg p-3 font-mono text-xs text-neutral-400 max-h-64 overflow-y-auto">
          {logs?.lines?.length ? (
            logs.lines.map((line, i) => (
              <div key={i} className={clsx('leading-5',
                line.includes('ERROR') || line.includes('error') ? 'text-rose-400' :
                line.includes('WARN') ? 'text-amber-400' :
                line.includes('info') || line.includes('INFO') ? 'text-blue-400' : 'text-neutral-500'
              )}>
                {line}
              </div>
            ))
          ) : (
            <div className="text-neutral-600">
              {logs ? 'No log entries found' : 'Log files not accessible in this environment'}
            </div>
          )}
        </div>
      </div>

      {/* Scheduled tasks */}
      <div className="card mt-4">
        <div className="text-sm font-semibold text-white mb-3 flex items-center gap-2">
          <RefreshCw size={14} />
          Heartbeat Tasks
        </div>
        <div className="space-y-2">
          {[
            { name: 'Morning Market Briefing', cron: '0 7 * * 1-5', next: 'Mon 7:00 AM ET', status: 'active' },
            { name: 'Morning Tasks Email', cron: '0 7 * * *', next: 'Tomorrow 7:00 AM ET', status: 'active' },
            { name: 'Ora Labs Order Check', cron: '0 9,13,17,21 * * *', next: 'Today 1:00 PM ET', status: 'active' },
            { name: 'System Health Check', cron: '*/30 * * * *', next: 'In ~15 min', status: 'active' },
          ].map(job => (
            <div key={job.name} className="flex items-center gap-3 py-2 border-b border-white/[0.04] last:border-0">
              <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <div className="flex-1">
                <div className="text-sm text-white">{job.name}</div>
                <div className="text-[10px] text-neutral-600 font-mono">{job.cron}</div>
              </div>
              <div className="text-xs text-neutral-500">{job.next}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

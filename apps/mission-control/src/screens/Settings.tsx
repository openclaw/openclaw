import { useQuery } from '@tanstack/react-query'
import { getConfig } from '../api/openclaw'
import { Settings as SettingsIcon, Shield, Zap, Server } from 'lucide-react'

export function Settings() {
  const { data: config } = useQuery({ queryKey: ['openclaw-config'], queryFn: getConfig })

  return (
    <div className="p-5 max-w-xl mx-auto">
      <div className="space-y-4">
        {/* Gateway */}
        <div className="card">
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
            <Server size={14} />
            Gateway
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-neutral-500">Port</span><span className="text-white font-mono">{config?.gateway?.port ?? 18789}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Mode</span><span className="text-white">{config?.gateway?.mode ?? 'local'}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Bind</span><span className="text-white">{config?.gateway?.bind ?? 'loopback'}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Auth</span><span className="text-white">{config?.gateway?.auth?.mode ?? 'token'}</span></div>
          </div>
        </div>

        {/* Default model */}
        <div className="card">
          <div className="flex items-center gap-2 mb-3 text-sm font-semibold text-white">
            <Zap size={14} />
            Agent Defaults
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-neutral-500">Default model</span><span className="text-white font-mono">{config?.agents?.defaults?.model ?? 'openai/gpt-4o-mini'}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Workspace</span><span className="text-white text-xs truncate max-w-[200px]">{config?.agents?.defaults?.workspace ?? '~/.openclaw/workspace'}</span></div>
          </div>
        </div>

        {/* Security note */}
        <div className="card border-amber-500/20 bg-amber-500/5">
          <div className="flex items-center gap-2 mb-2 text-sm font-semibold text-amber-400">
            <Shield size={14} />
            Security
          </div>
          <ul className="space-y-1 text-xs text-neutral-400">
            <li>✓ Gateway bound to loopback only</li>
            <li>✓ Auth token set</li>
            <li>✓ Telegram dmPolicy: allowlist (Jason only)</li>
            <li>⚠ WooCommerce API keys not yet configured</li>
            <li>⚠ Consider setting static IP (10.0.0.59)</li>
          </ul>
        </div>
      </div>
    </div>
  )
}

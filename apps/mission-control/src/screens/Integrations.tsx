import { CheckCircle2, XCircle, AlertCircle, ExternalLink } from 'lucide-react'
import clsx from 'clsx'
import type { Integration } from '../types'

const INTEGRATIONS: Integration[] = [
  { id: 'telegram', name: 'Telegram', type: 'api', status: 'connected', description: '@lucielthebot — DMs from Jason (ID: 5678617611)', icon: '✈️', lastUsedAt: new Date().toISOString() },
  { id: 'openai', name: 'OpenAI', type: 'api', status: 'connected', description: 'gpt-4o-mini — $30 credit balance', icon: '🤖', lastUsedAt: new Date().toISOString() },
  { id: 'anthropic', name: 'Anthropic', type: 'api', status: 'connected', description: 'Claude Opus / Sonnet — API key configured', icon: '🧠' },
  { id: 'gmail', name: 'Gmail', type: 'mcp', status: 'connected', description: 'jasonfg06@gmail.com — Read, draft, send', icon: '📧' },
  { id: 'gcal', name: 'Google Calendar', type: 'mcp', status: 'connected', description: 'Calendar management, event creation', icon: '📅' },
  { id: 'notion', name: 'Notion', type: 'mcp', status: 'connected', description: 'Workspace management — pages, databases', icon: '📓' },
  { id: 'wordpress', name: 'WordPress / WooCommerce', type: 'mcp', status: 'disconnected', description: 'Ora Labs store — API keys not configured', icon: '🌐' },
  { id: 'apollo', name: 'Apollo.io', type: 'mcp', status: 'connected', description: 'B2B prospecting and contact enrichment', icon: '🎯' },
  { id: 'firecrawl', name: 'Firecrawl', type: 'mcp', status: 'connected', description: 'Web crawling and content extraction', icon: '🔥' },
  { id: 'obsidian', name: 'Obsidian', type: 'mcp', status: 'connected', description: 'Local knowledge base management', icon: '🔮' },
  { id: 'github', name: 'GitHub', type: 'mcp', status: 'connected', description: 'Issue/PR management, code review', icon: '🐙' },
  { id: 'playwright', name: 'Playwright', type: 'mcp', status: 'connected', description: 'Browser automation and web testing', icon: '🎭' },
]

const STATUS_CONFIG = {
  connected: { icon: CheckCircle2, color: 'text-emerald-400', label: 'Connected', bg: 'bg-emerald-900/30 border-emerald-800/50' },
  disconnected: { icon: XCircle, color: 'text-neutral-600', label: 'Not configured', bg: 'bg-white/[0.02] border-white/[0.04]' },
  error: { icon: AlertCircle, color: 'text-rose-400', label: 'Error', bg: 'bg-rose-900/20 border-rose-800/30' },
}

const TYPE_COLORS = {
  mcp: 'bg-blue-900/40 text-blue-400',
  api: 'bg-violet-900/40 text-violet-400',
  webhook: 'bg-amber-900/40 text-amber-400',
}

export function Integrations() {
  const connected = INTEGRATIONS.filter(i => i.status === 'connected').length
  const byType = INTEGRATIONS.reduce<Record<string, Integration[]>>((acc, i) => {
    if (!acc[i.type]) acc[i.type] = []
    acc[i.type].push(i)
    return acc
  }, {})

  return (
    <div className="p-5">
      {/* Summary */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="card text-center">
          <div className="text-2xl font-bold text-emerald-400">{connected}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Connected</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-bold text-neutral-400">{INTEGRATIONS.length - connected}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Not configured</div>
        </div>
        <div className="card text-center">
          <div className="text-2xl font-bold text-white">{INTEGRATIONS.length}</div>
          <div className="text-xs text-neutral-500 mt-0.5">Total</div>
        </div>
      </div>

      {/* MCP Servers */}
      <div className="mb-5">
        <div className="flex items-center gap-2 mb-3">
          <span className={clsx('badge text-[10px]', TYPE_COLORS.mcp)}>MCP Servers</span>
          <div className="flex-1 h-px bg-white/[0.04]" />
          <span className="text-xs text-neutral-600">{byType.mcp?.length ?? 0}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {byType.mcp?.map(i => <IntCard key={i.id} i={i} />)}
        </div>
      </div>

      {/* API Integrations */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className={clsx('badge text-[10px]', TYPE_COLORS.api)}>API Keys</span>
          <div className="flex-1 h-px bg-white/[0.04]" />
          <span className="text-xs text-neutral-600">{byType.api?.length ?? 0}</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {byType.api?.map(i => <IntCard key={i.id} i={i} />)}
        </div>
      </div>
    </div>
  )
}

function IntCard({ i }: { i: Integration }) {
  const sc = STATUS_CONFIG[i.status]
  const StatusIcon = sc.icon
  return (
    <div className={clsx('card flex items-start gap-3 hover:border-white/[0.12] transition-all', i.status !== 'connected' && 'opacity-60')}>
      <div className="text-2xl shrink-0">{i.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-white">{i.name}</span>
          <StatusIcon size={12} className={sc.color} />
        </div>
        <p className="text-xs text-neutral-500 line-clamp-2">{i.description}</p>
        {i.lastUsedAt && i.status === 'connected' && (
          <div className="text-[10px] text-neutral-700 mt-1">
            Last used {new Date(i.lastUsedAt).toLocaleString()}
          </div>
        )}
      </div>
    </div>
  )
}

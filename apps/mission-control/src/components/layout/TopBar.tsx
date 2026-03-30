import { Search, Plus, Bell, Wifi, WifiOff } from 'lucide-react'
import { useStore } from '../../store'
import { useQuery } from '@tanstack/react-query'
import { getGatewayHealth } from '../../api/openclaw'
import { useLocation } from 'react-router-dom'

const TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/standup': 'Daily Standup',
  '/tasks': 'Tasks',
  '/calendar': 'Calendar',
  '/projects': 'Projects',
  '/docs': 'Docs',
  '/team': 'Team',
  '/office': 'Office',
  '/skills': 'Skills',
  '/memory': 'Memory',
  '/contacts': 'Contacts',
  '/messages': 'Messages',
  '/integrations': 'Integrations',
  '/system': 'System',
  '/radar': 'Radar',
  '/settings': 'Settings',
}

export function TopBar() {
  const { setSearchOpen, setQuickCaptureOpen } = useStore()
  const location = useLocation()
  const title = TITLES[location.pathname] ?? 'Mission Control'

  const { data: health } = useQuery({
    queryKey: ['gateway-health'],
    queryFn: getGatewayHealth,
    refetchInterval: 30_000,
  })

  const online = health?.online ?? false

  return (
    <header className="h-14 shrink-0 flex items-center gap-3 px-5 border-b border-white/[0.06] bg-[#0d0d0d]">
      <h1 className="text-sm font-semibold text-white flex-1">{title}</h1>

      {/* Gateway status */}
      <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full border ${
        online ? 'border-emerald-500/30 text-emerald-400 bg-emerald-500/10' : 'border-neutral-700 text-neutral-500 bg-white/[0.02]'
      }`}>
        {online ? <Wifi size={11} /> : <WifiOff size={11} />}
        <span>Gateway {online ? 'online' : 'offline'}</span>
        <div className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-400 animate-pulse' : 'bg-neutral-600'}`} />
      </div>

      {/* Search */}
      <button
        onClick={() => setSearchOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-neutral-500 hover:text-white hover:border-white/[0.12] transition-colors text-sm"
      >
        <Search size={13} />
        <span className="text-xs">Search</span>
        <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.06] text-neutral-600 font-mono">⌘K</kbd>
      </button>

      {/* Quick add */}
      <button
        onClick={() => setQuickCaptureOpen(true)}
        className="flex items-center gap-1.5 btn-primary"
      >
        <Plus size={14} />
        <span>New</span>
      </button>

      {/* Notifications */}
      <button className="w-8 h-8 flex items-center justify-center rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors relative">
        <Bell size={15} />
        <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-blue-500" />
      </button>
    </header>
  )
}

import { NavLink, useLocation } from 'react-router-dom'
import {
  CheckSquare, Calendar, FolderOpen, Brain, FileText, Users, Building2,
  Zap, Settings, Radio, Cpu, MessageSquare, BookUser, Network, TrendingUp,
  LayoutDashboard, ChevronRight
} from 'lucide-react'
import clsx from 'clsx'

const NAV = [
  { group: 'Overview', items: [
    { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
    { to: '/standup', icon: TrendingUp, label: 'Standup' },
  ]},
  { group: 'Work', items: [
    { to: '/tasks', icon: CheckSquare, label: 'Tasks' },
    { to: '/calendar', icon: Calendar, label: 'Calendar' },
    { to: '/projects', icon: FolderOpen, label: 'Projects' },
    { to: '/docs', icon: FileText, label: 'Docs' },
  ]},
  { group: 'Agents', items: [
    { to: '/team', icon: Users, label: 'Team' },
    { to: '/office', icon: Building2, label: 'Office' },
    { to: '/skills', icon: Zap, label: 'Skills' },
  ]},
  { group: 'Knowledge', items: [
    { to: '/memory', icon: Brain, label: 'Memory' },
    { to: '/contacts', icon: BookUser, label: 'Contacts' },
    { to: '/messages', icon: MessageSquare, label: 'Messages' },
  ]},
  { group: 'System', items: [
    { to: '/integrations', icon: Network, label: 'Integrations' },
    { to: '/system', icon: Cpu, label: 'System' },
    { to: '/radar', icon: Radio, label: 'Radar' },
    { to: '/settings', icon: Settings, label: 'Settings' },
  ]},
]

export function Sidebar() {
  const location = useLocation()

  return (
    <aside className="w-56 shrink-0 flex flex-col h-full border-r border-white/[0.06] bg-[#0d0d0d]">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-white/[0.06]">
        <div className="w-7 h-7 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-xs shrink-0">
          MC
        </div>
        <div>
          <div className="text-sm font-semibold text-white">Mission Control</div>
          <div className="text-[10px] text-neutral-500 leading-none">OpenClaw v2026.3</div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-3 px-2">
        {NAV.map(({ group, items }) => (
          <div key={group} className="mb-4">
            <div className="text-[10px] font-semibold uppercase tracking-widest text-neutral-600 px-3 mb-1">{group}</div>
            {items.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) => clsx('nav-item', isActive && 'active')}
              >
                <Icon size={15} className="shrink-0" />
                <span className="flex-1">{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/[0.06]">
        <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-white/[0.04] cursor-pointer transition-colors">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-xs font-semibold text-white shrink-0">J</div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-white truncate">Jason Figueroa</div>
            <div className="text-[10px] text-neutral-500 truncate">Ora Labs</div>
          </div>
          <ChevronRight size={12} className="text-neutral-600" />
        </div>
      </div>
    </aside>
  )
}

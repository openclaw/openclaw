import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard,
  Bot,
  ListTodo,
  Plug,
  Activity,
  Settings,
  Bell,
  Search,
  Menu,
  X,
  ExternalLink,
  BarChart3,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { api } from '../services/api'
import clsx from 'clsx'

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Tasks', href: '/tasks', icon: ListTodo },
  { name: 'Integrations', href: '/integrations', icon: Plug },
  { name: 'Activity', href: '/activity', icon: Activity },
  { name: 'Monitoring', href: '/monitoring', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()

  // Fetch system status
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: api.getStatus,
    refetchInterval: 30000, // Refresh every 30 seconds
  })

  // Fetch notifications count
  const { data: notifications } = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.getNotifications(true),
    refetchInterval: 60000,
  })

  const unreadCount = notifications?.notifications?.length || 0
  const normalizedSearch = searchQuery.trim().toLowerCase()

  const { data: searchAgentsData, isFetching: searchAgentsLoading } = useQuery({
    queryKey: ['search', 'agents'],
    queryFn: api.getAgents,
    enabled: normalizedSearch.length >= 2,
    staleTime: 30000,
  })

  const { data: searchTasksData, isFetching: searchTasksLoading } = useQuery({
    queryKey: ['search', 'tasks'],
    queryFn: () => api.getTasks({ limit: 200 }),
    enabled: normalizedSearch.length >= 2,
    staleTime: 30000,
  })

  const searchResults = useMemo(() => {
    if (normalizedSearch.length < 2) {return []}

    const agentMatches = (searchAgentsData?.agents || [])
      .filter((agent) =>
        agent.name.toLowerCase().includes(normalizedSearch) ||
        agent.slug.toLowerCase().includes(normalizedSearch)
      )
      .slice(0, 4)
      .map((agent) => ({
        id: `agent-${agent.slug}`,
        type: 'Agent',
        title: agent.name,
        subtitle: agent.slug,
        path: `/agents/${agent.slug}`,
      }))

    const taskMatches = (searchTasksData?.tasks || [])
      .filter((task) =>
        task.name.toLowerCase().includes(normalizedSearch) ||
        task.task_type.toLowerCase().includes(normalizedSearch)
      )
      .slice(0, 4)
      .map((task) => ({
        id: `task-${task.id}`,
        type: 'Task',
        title: task.name,
        subtitle: task.task_type,
        path: `/tasks?search=${encodeURIComponent(task.name)}`,
      }))

    return [...agentMatches, ...taskMatches].slice(0, 8)
  }, [normalizedSearch, searchAgentsData?.agents, searchTasksData?.tasks])

  const searchBusy = searchAgentsLoading || searchTasksLoading
  const showSearchDropdown = searchFocused && normalizedSearch.length >= 2

  const submitSearch = (query: string) => {
    const term = query.trim()
    if (!term) {return}

    if (searchResults.length > 0) {
      navigate(searchResults[0].path)
    } else {
      navigate(`/tasks?search=${encodeURIComponent(term)}`)
    }
    setSearchFocused(false)
    setSearchQuery('')
  }

  return (
    <div className="min-h-screen flex">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-50 w-64 bg-surface-900 border-r border-surface-800',
          'transform transition-transform duration-300 lg:translate-x-0 lg:static',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-6 border-b border-surface-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center">
              <Bot className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-lg font-bold gradient-text">OpenClaw</h1>
              <p className="text-xs text-surface-500">Agent Manager</p>
            </div>
          </div>
          <button
            className="ml-auto lg:hidden btn-icon"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="p-4 space-y-1">
          {navigation.map((item) => {
            const isActive = location.pathname === item.href || 
              (item.href !== '/' && location.pathname.startsWith(item.href))
            
            return (
              <NavLink
                key={item.name}
                to={item.href}
                className={clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-500/20 text-primary-400'
                    : 'text-surface-400 hover:text-surface-100 hover:bg-surface-800'
                )}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon className="w-5 h-5" />
                {item.name}
              </NavLink>
            )
          })}
        </nav>

        {/* Status indicator + cross-link */}
        <div className="absolute bottom-0 left-0 right-0 p-4 border-t border-surface-800 space-y-2">
          <a
            href="http://127.0.0.1:18800"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-surface-400 hover:text-primary-400 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            Gateway config
          </a>
          <div className="flex items-center gap-2 text-sm">
            <div className={clsx(
              'status-dot',
              status?.status === 'running' ? 'status-dot-success' : 'status-dot-error'
            )} />
            <span className="text-surface-400">
              System {status?.status || 'checking...'}
            </span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-h-screen">
        {/* Header */}
        <header className="h-16 flex items-center justify-between px-6 border-b border-surface-800 bg-surface-900/50 backdrop-blur-sm sticky top-0 z-30">
          <div className="flex items-center gap-4">
          <button
            className="lg:hidden btn-icon"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="w-5 h-5" />
          </button>
            
            {/* Search */}
            <div
              className="relative hidden sm:block"
              onFocus={() => setSearchFocused(true)}
              onBlur={() => {
                window.setTimeout(() => setSearchFocused(false), 120)
              }}
            >
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" />
              <input
                type="text"
                placeholder="Search agents, tasks..."
                className="input pl-10 w-64 bg-surface-800/50"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    submitSearch(searchQuery)
                  }
                }}
                aria-label="Search agents and tasks"
              />
              {showSearchDropdown && (
                <div className="absolute top-full mt-2 w-full rounded-lg border border-surface-700 bg-surface-900 shadow-xl overflow-hidden z-50">
                  {searchBusy ? (
                    <div className="px-3 py-2 text-sm text-surface-400">Searching…</div>
                  ) : searchResults.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-surface-400">
                      No results. Press Enter to search tasks.
                    </div>
                  ) : (
                    searchResults.map((result) => (
                      <button
                        key={result.id}
                        className="w-full px-3 py-2 text-left hover:bg-surface-800 transition-colors"
                        onMouseDown={(event) => {
                          event.preventDefault()
                          navigate(result.path)
                          setSearchFocused(false)
                          setSearchQuery('')
                        }}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-surface-100 truncate">{result.title}</span>
                          <span className="text-[10px] uppercase tracking-wide text-surface-500">{result.type}</span>
                        </div>
                        <p className="text-xs text-surface-500 truncate">{result.subtitle}</p>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* Notifications */}
            <button className="btn-icon relative" aria-label="Notifications">
              <Bell className="w-5 h-5 text-surface-400" />
              {unreadCount > 0 && (
                <span className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 rounded-full text-xs flex items-center justify-center">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </button>

            {/* User */}
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary-500 to-accent-500 flex items-center justify-center text-white font-medium text-sm">
                AB
              </div>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useStore } from '../store'
import { Search, X, CheckSquare, Brain, FileText, FolderOpen, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

export function SearchModal() {
  const { setSearchOpen, tasks, memories, docs, projects, agents } = useStore()
  const [q, setQ] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
      if (e.key === 'Escape') setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [setSearchOpen])

  const lower = q.toLowerCase()
  const results = q.length > 1 ? [
    ...tasks.filter(t => t.title.toLowerCase().includes(lower)).slice(0, 3).map(t => ({
      id: t.id, type: 'task' as const, label: t.title, sub: t.status, to: '/tasks', icon: CheckSquare
    })),
    ...memories.filter(m => m.content.toLowerCase().includes(lower)).slice(0, 2).map(m => ({
      id: m.id, type: 'memory' as const, label: m.content.slice(0, 60), sub: m.date, to: '/memory', icon: Brain
    })),
    ...docs.filter(d => d.title.toLowerCase().includes(lower) || d.content.toLowerCase().includes(lower)).slice(0, 2).map(d => ({
      id: d.id, type: 'doc' as const, label: d.title, sub: d.type, to: '/docs', icon: FileText
    })),
    ...projects.filter(p => p.name.toLowerCase().includes(lower)).slice(0, 2).map(p => ({
      id: p.id, type: 'project' as const, label: p.name, sub: p.status, to: '/projects', icon: FolderOpen
    })),
    ...agents.filter(a => a.name.toLowerCase().includes(lower)).slice(0, 2).map(a => ({
      id: a.id, type: 'agent' as const, label: a.name, sub: a.role, to: '/team', icon: Users
    })),
  ] : []

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-24 px-4"
      onClick={() => setSearchOpen(false)}>
      <div className="bg-[#141414] border border-white/[0.1] rounded-2xl w-full max-w-lg shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/[0.06]">
          <Search size={16} className="text-neutral-500" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-white placeholder-neutral-600 outline-none text-sm"
            placeholder="Search tasks, memories, docs, agents…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <button onClick={() => setSearchOpen(false)}><X size={14} className="text-neutral-600 hover:text-white" /></button>
        </div>
        {results.length > 0 && (
          <div className="py-2">
            {results.map(r => {
              const Icon = r.icon
              return (
                <button
                  key={r.id}
                  className="w-full flex items-center gap-3 px-4 py-2 hover:bg-white/[0.05] transition-colors text-left"
                  onClick={() => { navigate(r.to); setSearchOpen(false) }}
                >
                  <Icon size={13} className="text-neutral-500 shrink-0" />
                  <span className="flex-1 text-sm text-white truncate">{r.label}</span>
                  <span className="text-[10px] text-neutral-600">{r.sub}</span>
                </button>
              )
            })}
          </div>
        )}
        {q.length > 1 && results.length === 0 && (
          <div className="py-8 text-center text-sm text-neutral-600">No results for "{q}"</div>
        )}
        {!q && (
          <div className="py-4 px-4">
            <div className="text-[10px] text-neutral-700 uppercase tracking-widest mb-2">Quick navigate</div>
            {[
              { to: '/tasks', label: 'Tasks', icon: CheckSquare },
              { to: '/memory', label: 'Memory', icon: Brain },
              { to: '/docs', label: 'Docs', icon: FileText },
            ].map(({ to, label, icon: Icon }) => (
              <button key={to} className="w-full flex items-center gap-3 px-2 py-1.5 hover:bg-white/[0.04] rounded-lg transition-colors text-left"
                onClick={() => { navigate(to); setSearchOpen(false) }}>
                <Icon size={13} className="text-neutral-600" />
                <span className="text-sm text-neutral-400">{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

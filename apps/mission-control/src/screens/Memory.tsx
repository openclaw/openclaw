import { useState } from 'react'
import { useStore } from '../store'
import { useQuery } from '@tanstack/react-query'
import { getWorkspaceFiles } from '../api/openclaw'
import { Brain, Search, Plus, Calendar, User, Bot, Cpu, Tag } from 'lucide-react'
import clsx from 'clsx'
import type { Memory } from '../types'

const SOURCE_ICONS = { agent: Bot, user: User, system: Cpu }
const SOURCE_COLORS = { agent: 'text-blue-400', user: 'text-emerald-400', system: 'text-violet-400' }

function MemCard({ mem }: { mem: Memory }) {
  const { agents } = useStore()
  const agent = agents.find(a => a.id === mem.agentId)
  const Icon = SOURCE_ICONS[mem.source]

  return (
    <div className={clsx('card hover:border-white/[0.12] transition-all', mem.type === 'long' ? 'border-l-2 border-l-blue-500/40' : '')}>
      <div className="flex items-start gap-2 mb-2">
        <Icon size={13} className={clsx('mt-0.5 shrink-0', SOURCE_COLORS[mem.source])} />
        <p className="text-sm text-neutral-200 leading-relaxed flex-1">{mem.content}</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className={clsx('badge text-[10px]', mem.type === 'long' ? 'bg-blue-900/40 text-blue-400' : 'bg-white/[0.05] text-neutral-500')}>
          {mem.type === 'long' ? 'Long-term' : 'Short-term'}
        </span>
        {agent && <span className="text-[10px] text-neutral-500">{agent.emoji} {agent.name}</span>}
        {mem.tags.map(t => (
          <span key={t} className="flex items-center gap-0.5 text-[10px] text-neutral-600">
            <Tag size={8} />
            {t}
          </span>
        ))}
        <span className="ml-auto text-[10px] text-neutral-700 flex items-center gap-1">
          <Calendar size={9} />
          {mem.date}
        </span>
      </div>
    </div>
  )
}

export function Memory() {
  const { memories, addMemory } = useStore()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'long' | 'short'>('all')
  const [showAdd, setShowAdd] = useState(false)
  const [newContent, setNewContent] = useState('')

  const { data: wsFiles } = useQuery({
    queryKey: ['workspace-files'],
    queryFn: getWorkspaceFiles,
    staleTime: 60_000,
  })

  // Merge real workspace memories with stored ones
  const realMemories: Memory[] = []
  if (wsFiles?.memory) {
    for (const m of wsFiles.memory as any[]) {
      realMemories.push({
        id: `real-${m.date}`,
        content: m.content?.slice(0, 300) + (m.content?.length > 300 ? '…' : '') ?? '',
        type: 'long',
        source: 'agent',
        tags: ['workspace', 'daily'],
        createdAt: m.date,
        date: m.date,
      })
    }
  }

  const allMemories = [...realMemories, ...memories]

  const filtered = allMemories.filter(m => {
    if (filter !== 'all' && m.type !== filter) return false
    if (search && !m.content.toLowerCase().includes(search.toLowerCase()) &&
        !m.tags.some(t => t.toLowerCase().includes(search.toLowerCase()))) return false
    return true
  })

  // Group by date
  const grouped: Record<string, Memory[]> = {}
  for (const m of filtered) {
    const d = m.date
    if (!grouped[d]) grouped[d] = []
    grouped[d].push(m)
  }
  const dates = Object.keys(grouped).sort().reverse()

  const handleAdd = () => {
    if (!newContent.trim()) return
    addMemory({ content: newContent.trim(), type: 'short', source: 'user', tags: [], date: new Date().toISOString().slice(0, 10) })
    setNewContent('')
    setShowAdd(false)
  }

  return (
    <div className="p-5 max-w-3xl mx-auto">
      {/* Toolbar */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input className="input pl-8" placeholder="Search memories…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 p-1 bg-white/[0.04] rounded-lg border border-white/[0.06]">
          {(['all', 'long', 'short'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={clsx('px-3 py-1 rounded text-xs transition-colors capitalize', filter === f ? 'bg-white/[0.08] text-white' : 'text-neutral-500 hover:text-white')}>
              {f === 'all' ? 'All' : f === 'long' ? 'Long-term' : 'Short-term'}
            </button>
          ))}
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5">
          <Plus size={13} />
          Add
        </button>
      </div>

      {/* Quick add */}
      {showAdd && (
        <div className="card mb-4">
          <textarea
            autoFocus
            className="input min-h-[80px] resize-none text-sm mb-2"
            placeholder="Write a memory…"
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary text-xs" onClick={handleAdd}>Save memory</button>
            <button className="btn-ghost text-xs" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Workspace files summary */}
      {wsFiles && (
        <div className="card mb-4 border-violet-500/20 bg-violet-500/5">
          <div className="text-xs text-violet-400 font-semibold mb-1 flex items-center gap-1.5">
            <Brain size={12} />
            Agent Long-term Memory — Live from workspace
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400">
            {wsFiles['IDENTITY.md'] && <div>✓ Identity configured</div>}
            {wsFiles['SOUL.md'] && <div>✓ Soul file present</div>}
            {wsFiles['USER.md'] && <div>✓ User profile present</div>}
            {wsFiles['MEMORY.md'] && <div>✓ Memory.md present</div>}
          </div>
        </div>
      )}

      {/* Grouped memories */}
      {dates.map(date => (
        <div key={date} className="mb-5">
          <div className="text-xs font-semibold text-neutral-600 mb-2 flex items-center gap-2">
            <Calendar size={11} />
            {date}
            <div className="flex-1 h-px bg-white/[0.04]" />
            <span>{grouped[date].length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {grouped[date].map(m => <MemCard key={m.id} mem={m} />)}
          </div>
        </div>
      ))}

      {filtered.length === 0 && (
        <div className="text-center py-16 text-neutral-600">
          <Brain size={32} className="mx-auto mb-2 opacity-30" />
          <div className="text-sm">No memories found</div>
        </div>
      )}
    </div>
  )
}

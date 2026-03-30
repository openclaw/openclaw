import { useState } from 'react'
import { useStore } from '../store'
import type { Doc } from '../types'
import { FileText, Search, Plus, Calendar, Tag, Eye } from 'lucide-react'
import clsx from 'clsx'

const TYPE_COLORS = {
  plan: 'bg-blue-900/40 text-blue-400',
  draft: 'bg-amber-900/40 text-amber-400',
  report: 'bg-emerald-900/40 text-emerald-400',
  guide: 'bg-violet-900/40 text-violet-400',
  note: 'bg-neutral-800 text-neutral-400',
}

const TYPE_ICONS = { plan: '📋', draft: '✏️', report: '📊', guide: '📖', note: '📝' }

function DocCard({ doc, onOpen }: { doc: Doc; onOpen: (d: Doc) => void }) {
  const preview = doc.content.replace(/^#+ /gm, '').replace(/\n/g, ' ').slice(0, 120)
  return (
    <div
      className="card hover:border-white/[0.12] transition-all cursor-pointer group"
      onClick={() => onOpen(doc)}
    >
      <div className="flex items-start gap-2 mb-2">
        <span className="text-xl shrink-0">{TYPE_ICONS[doc.type]}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white mb-0.5 group-hover:text-blue-300 transition-colors">{doc.title}</div>
          <span className={clsx('badge text-[10px]', TYPE_COLORS[doc.type])}>{doc.type}</span>
        </div>
        <Eye size={13} className="text-neutral-700 group-hover:text-neutral-400 transition-colors shrink-0" />
      </div>
      <p className="text-xs text-neutral-500 line-clamp-2 mb-2">{preview}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {doc.tags.map(t => (
          <span key={t} className="flex items-center gap-0.5 text-[10px] text-neutral-600"><Tag size={8} />{t}</span>
        ))}
        <span className="ml-auto text-[10px] text-neutral-700 flex items-center gap-1">
          <Calendar size={9} />
          {new Date(doc.updatedAt).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}

function DocViewer({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const lines = doc.content.split('\n')
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6" onClick={onClose}>
      <div className="bg-[#141414] border border-white/[0.1] rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-5 py-4 border-b border-white/[0.06]">
          <span className="text-xl">{TYPE_ICONS[doc.type]}</span>
          <div className="flex-1">
            <div className="text-sm font-semibold text-white">{doc.title}</div>
            <div className="text-xs text-neutral-500">{new Date(doc.updatedAt).toLocaleString()}</div>
          </div>
          <button onClick={onClose} className="btn-ghost text-xs">Close</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <pre className="text-sm text-neutral-300 font-mono whitespace-pre-wrap leading-relaxed">{doc.content}</pre>
        </div>
      </div>
    </div>
  )
}

export function Docs() {
  const { docs, addDoc } = useStore()
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<Doc['type'] | 'all'>('all')
  const [viewing, setViewing] = useState<Doc | null>(null)
  const [showNew, setShowNew] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newContent, setNewContent] = useState('')
  const [newType, setNewType] = useState<Doc['type']>('note')

  const filtered = docs.filter(d => {
    if (typeFilter !== 'all' && d.type !== typeFilter) return false
    if (search && !d.title.toLowerCase().includes(search.toLowerCase()) &&
        !d.content.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const handleAdd = () => {
    if (!newTitle.trim()) return
    addDoc({ title: newTitle.trim(), content: newContent, type: newType, tags: [] })
    setNewTitle(''); setNewContent(''); setShowNew(false)
  }

  return (
    <div className="p-5">
      {/* Toolbar */}
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input className="input pl-8" placeholder="Search docs…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 p-1 bg-white/[0.04] rounded-lg border border-white/[0.06]">
          {(['all', 'plan', 'guide', 'report', 'draft', 'note'] as const).map(f => (
            <button key={f} onClick={() => setTypeFilter(f)}
              className={clsx('px-2.5 py-1 rounded text-[11px] transition-colors capitalize', typeFilter === f ? 'bg-white/[0.08] text-white' : 'text-neutral-500 hover:text-white')}>
              {f}
            </button>
          ))}
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-1.5">
          <Plus size={13} />
          New Doc
        </button>
      </div>

      {/* New doc form */}
      {showNew && (
        <div className="card mb-4 border-blue-500/20">
          <div className="flex gap-2 mb-2">
            <input className="input flex-1" placeholder="Document title…" value={newTitle} onChange={e => setNewTitle(e.target.value)} />
            <select
              className="input w-32 bg-[#1a1a1a]"
              value={newType}
              onChange={e => setNewType(e.target.value as Doc['type'])}
            >
              {(['plan','draft','report','guide','note'] as const).map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <textarea
            className="input min-h-[120px] resize-none text-sm mb-2"
            placeholder="Content (markdown supported)…"
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary text-xs" onClick={handleAdd}>Save</button>
            <button className="btn-ghost text-xs" onClick={() => setShowNew(false)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Docs grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {filtered.map(d => <DocCard key={d.id} doc={d} onOpen={setViewing} />)}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-16 text-neutral-600">
          <FileText size={32} className="mx-auto mb-2 opacity-30" />
          <div className="text-sm">No docs found</div>
        </div>
      )}

      {viewing && <DocViewer doc={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

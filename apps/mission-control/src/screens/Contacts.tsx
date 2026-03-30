import { useState } from 'react'
import { useStore } from '../store'
import { Search, Plus, Mail, Building2, User2, Tag } from 'lucide-react'

export function Contacts() {
  const { contacts, addContact } = useStore()
  const [search, setSearch] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [role, setRole] = useState('')

  const filtered = contacts.filter(c =>
    !search ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.email?.toLowerCase().includes(search.toLowerCase()) ||
    c.company?.toLowerCase().includes(search.toLowerCase())
  )

  const handleAdd = () => {
    if (!name.trim()) return
    addContact({ name: name.trim(), email: email.trim() || undefined, company: company.trim() || undefined, role: role.trim() || undefined, tags: [] })
    setName(''); setEmail(''); setCompany(''); setRole(''); setShowAdd(false)
  }

  return (
    <div className="p-5 max-w-2xl mx-auto">
      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
          <input className="input pl-8" placeholder="Search contacts…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5">
          <Plus size={13} />
          Add
        </button>
      </div>

      {showAdd && (
        <div className="card mb-4 border-blue-500/20">
          <div className="grid grid-cols-2 gap-2 mb-2">
            <input className="input" placeholder="Name*" value={name} onChange={e => setName(e.target.value)} />
            <input className="input" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
            <input className="input" placeholder="Company" value={company} onChange={e => setCompany(e.target.value)} />
            <input className="input" placeholder="Role" value={role} onChange={e => setRole(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary text-xs" onClick={handleAdd}>Save contact</button>
            <button className="btn-ghost text-xs" onClick={() => setShowAdd(false)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(c => (
          <div key={c.id} className="card flex items-center gap-3 hover:border-white/[0.12] transition-all">
            <div className="w-9 h-9 rounded-full bg-white/[0.06] flex items-center justify-center text-sm font-semibold text-white shrink-0">
              {c.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white">{c.name}</div>
              <div className="flex items-center gap-3 text-[11px] text-neutral-500">
                {c.email && <span className="flex items-center gap-1"><Mail size={9} />{c.email}</span>}
                {c.company && <span className="flex items-center gap-1"><Building2 size={9} />{c.company}</span>}
                {c.role && <span className="flex items-center gap-1"><User2 size={9} />{c.role}</span>}
              </div>
            </div>
            <div className="flex gap-1">
              {c.tags.map(t => <span key={t} className="badge bg-white/[0.04] text-neutral-500 text-[10px]">{t}</span>)}
            </div>
          </div>
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-12 text-neutral-600 text-sm">No contacts yet</div>
      )}
    </div>
  )
}

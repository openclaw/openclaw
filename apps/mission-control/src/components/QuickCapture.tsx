import { useState } from 'react'
import { useStore } from '../store'
import { X, CheckSquare, Brain, FileText } from 'lucide-react'

type Mode = 'task' | 'memory' | 'doc'

export function QuickCapture() {
  const { setQuickCaptureOpen, addTask, addMemory, addDoc } = useStore()
  const [mode, setMode] = useState<Mode>('task')
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')

  const handleSubmit = () => {
    if (mode === 'task' && text.trim()) {
      addTask({ title: text.trim(), status: 'backlog', priority: 'medium', tags: [] })
    } else if (mode === 'memory' && text.trim()) {
      addMemory({ content: text.trim(), type: 'short', source: 'user', tags: [], date: new Date().toISOString().slice(0, 10) })
    } else if (mode === 'doc' && title.trim()) {
      addDoc({ title: title.trim(), content: text, type: 'note', tags: [] })
    }
    setQuickCaptureOpen(false)
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-24 px-4"
      onClick={() => setQuickCaptureOpen(false)}>
      <div className="bg-[#141414] border border-white/[0.1] rounded-2xl w-full max-w-lg shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/[0.06]">
          <div className="flex gap-1 p-1 bg-white/[0.04] rounded-lg">
            {([
              { id: 'task', icon: CheckSquare, label: 'Task' },
              { id: 'memory', icon: Brain, label: 'Memory' },
              { id: 'doc', icon: FileText, label: 'Doc' },
            ] as const).map(({ id, icon: Icon, label }) => (
              <button key={id} onClick={() => setMode(id)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs transition-colors ${mode === id ? 'bg-white/[0.1] text-white' : 'text-neutral-500 hover:text-white'}`}>
                <Icon size={11} />
                {label}
              </button>
            ))}
          </div>
          <button onClick={() => setQuickCaptureOpen(false)} className="text-neutral-600 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {mode === 'doc' && (
            <input
              className="input mb-2"
              placeholder="Document title…"
              value={title}
              onChange={e => setTitle(e.target.value)}
            />
          )}
          <textarea
            autoFocus
            className="input min-h-[100px] resize-none"
            placeholder={
              mode === 'task' ? 'What needs to be done?' :
              mode === 'memory' ? 'What should I remember?' :
              'Document content…'
            }
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit()
              if (e.key === 'Escape') setQuickCaptureOpen(false)
            }}
          />
          <div className="flex items-center justify-between mt-3">
            <div className="text-xs text-neutral-600">⌘↵ to save</div>
            <div className="flex gap-2">
              <button className="btn-ghost text-xs" onClick={() => setQuickCaptureOpen(false)}>Cancel</button>
              <button className="btn-primary text-xs" onClick={handleSubmit}>Save</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

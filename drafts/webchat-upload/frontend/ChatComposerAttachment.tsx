// Draft React snippet: add attach button + drag & drop + paste image support
// Integrate into the existing web console front-end (adjust imports/styles/state mgmt).

import React, { useCallback, useEffect, useRef, useState } from 'react'

type QueueItem = {
  id: string
  file: File
  previewURL?: string
  status: 'queued' | 'uploading' | 'done' | 'error'
  serverPath?: string
  error?: string
}

async function uploadFiles(items: QueueItem[]): Promise<QueueItem[]> {
  const form = new FormData()
  items.forEach(i => form.append('file', i.file, i.file.name))
  const res = await fetch('/api/media/upload', { method: 'POST', body: form })
  if (!res.ok) throw new Error(`upload failed: ${res.status}`)
  const json = await res.json()
  return items.map((it, idx) => ({ ...it, status: 'done', serverPath: json.files[idx]?.path }))
}

export function ChatComposerAttachment({ onSend }: { onSend: (payload: { text?: string, media?: { path: string }[] }) => Promise<void> }) {
  const [text, setText] = useState('')
  const [queue, setQueue] = useState<QueueItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const pickFiles = () => inputRef.current?.click()
  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    const next = files.map(f => ({ id: crypto.randomUUID(), file: f, previewURL: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined, status: 'queued' as const }))
    setQueue(q => [...q, ...next])
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files || [])
    const next = files.map(f => ({ id: crypto.randomUUID(), file: f, previewURL: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined, status: 'queued' as const }))
    setQueue(q => [...q, ...next])
  }

  const onPaste = useCallback((e: ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items || [])
    const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
    if (files.length) {
      e.preventDefault()
      const next = files.map(f => ({ id: crypto.randomUUID(), file: f, previewURL: f.type.startsWith('image/') ? URL.createObjectURL(f) : undefined, status: 'queued' as const }))
      setQueue(q => [...q, ...next])
    }
  }, [])

  useEffect(() => {
    const handler = (ev: ClipboardEvent) => onPaste(ev)
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [onPaste])

  const send = async () => {
    // upload queued files
    const queued = queue.filter(q => q.status === 'queued')
    let uploaded: QueueItem[] = []
    if (queued.length) {
      setQueue(q => q.map(i => i.status === 'queued' ? { ...i, status: 'uploading' } : i))
      try {
        uploaded = await uploadFiles(queued)
        setQueue(q => q.map(i => i.status !== 'queued' ? i : uploaded.find(u => u.file === i.file) || i))
      } catch (e: any) {
        setQueue(q => q.map(i => i.status === 'uploading' ? { ...i, status: 'error', error: String(e?.message || e) } : i))
        return
      }
    }

    const media = queue.map(i => i.serverPath).filter(Boolean).map(p => ({ path: p! }))
    await onSend({ text: text.trim() || undefined, media: media.length ? media : undefined })
    setText('')
    setQueue([])
  }

  return (
    <div className="composer" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
      <input ref={inputRef} type="file" multiple hidden onChange={onFileChange} />
      <button type="button" onClick={pickFiles} aria-label="Attach">📎</button>
      <input value={text} onChange={e => setText(e.target.value)} placeholder="Message (paste images or drag files here)" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} />
      <button type="button" onClick={send}>Send</button>
      {queue.length > 0 && (
        <div className="attachments">
          {queue.map(it => (
            <div key={it.id} className={`chip ${it.status}`}>
              {it.previewURL ? <img src={it.previewURL} alt={it.file.name} /> : <span className="file-icon" />}
              <span className="name">{it.file.name}</span>
              <span className="size">{(it.file.size/1024).toFixed(1)} KB</span>
              {it.status === 'uploading' && <span className="progress" />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

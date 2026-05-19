import { useMemo, useState } from 'react'
import './DiffViewer.css'

type DiffViewerProps = {
  filePath: string
  diffText: string
  defaultExpanded?: boolean
}

type DiffLine = {
  text: string
  kind: 'add' | 'remove' | 'meta' | 'normal'
}

function classifyLine(line: string): DiffLine {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) {
    return { text: line, kind: 'meta' }
  }
  if (line.startsWith('+')) {
    return { text: line, kind: 'add' }
  }
  if (line.startsWith('-')) {
    return { text: line, kind: 'remove' }
  }
  return { text: line, kind: 'normal' }
}

export function DiffViewer({
  filePath,
  diffText,
  defaultExpanded = true,
}: DiffViewerProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const lines = useMemo(
    () => diffText.split('\n').map((line) => classifyLine(line)),
    [diffText],
  )

  return (
    <section className="diff-viewer">
      <header className="diff-viewer-head">
        <div className="diff-viewer-path">{filePath}</div>
        <button type="button" onClick={() => setExpanded((prev) => !prev)}>
          {expanded ? '收合' : '展開'}
        </button>
      </header>

      {expanded ? (
        <div className="diff-viewer-body">
          {lines.length === 0 || (lines.length === 1 && lines[0].text === '') ? (
            <div className="diff-line diff-normal">尚無 Diff 內容</div>
          ) : (
            lines.map((line, index) => (
              <div
                key={`diff-line-${index}`}
                className={`diff-line diff-${line.kind}`}
              >
                {line.text || ' '}
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  )
}

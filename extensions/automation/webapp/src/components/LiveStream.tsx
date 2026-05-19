import { useEffect, useMemo, useRef, useState } from 'react'
import './LiveStream.css'

type LiveStreamProps = {
  lines: string[]
  isStreaming?: boolean
  className?: string
}

type AnsiToken = {
  text: string
  className?: string
}

const ansiColorClassMap: Record<number, string> = {
  30: 'ansi-black',
  31: 'ansi-red',
  32: 'ansi-green',
  33: 'ansi-yellow',
  34: 'ansi-blue',
  35: 'ansi-magenta',
  36: 'ansi-cyan',
  37: 'ansi-white',
  90: 'ansi-bright-black',
  91: 'ansi-bright-red',
  92: 'ansi-bright-green',
  93: 'ansi-bright-yellow',
  94: 'ansi-bright-blue',
  95: 'ansi-bright-magenta',
  96: 'ansi-bright-cyan',
  97: 'ansi-bright-white',
}

function parseAnsiLine(line: string): AnsiToken[] {
  const regex = /\x1b\[([0-9;]*)m/g
  const tokens: AnsiToken[] = []
  let activeClass = ''
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(line)) !== null) {
    const text = line.slice(cursor, match.index)
    if (text) {
      tokens.push({ text, className: activeClass || undefined })
    }

    const codes = match[1]
      .split(';')
      .map((item) => Number.parseInt(item, 10))
      .filter((item) => Number.isFinite(item))

    if (codes.length === 0 || codes.includes(0)) {
      activeClass = ''
    } else {
      const colorCode = codes.find((code) => code in ansiColorClassMap)
      activeClass = colorCode ? ansiColorClassMap[colorCode] : activeClass
    }

    cursor = match.index + match[0].length
  }

  const tail = line.slice(cursor)
  if (tail) {
    tokens.push({ text: tail, className: activeClass || undefined })
  }

  return tokens.length > 0 ? tokens : [{ text: line }]
}

export function LiveStream({ lines, isStreaming = false, className = '' }: LiveStreamProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [copyMessage, setCopyMessage] = useState('')

  const normalizedLines = useMemo(
    () => lines.map((line) => parseAnsiLine(line)),
    [lines],
  )

  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    el.scrollTop = el.scrollHeight
  }, [normalizedLines])

  async function copyAll(): Promise<void> {
    const text = lines.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyMessage('已複製輸出內容')
    } catch {
      setCopyMessage('複製失敗')
    }
    setTimeout(() => setCopyMessage(''), 1200)
  }

  return (
    <section className={`live-stream ${className}`.trim()}>
      <div className="live-stream-head">
        <span>{isStreaming ? '串流中' : '已停止'}</span>
        <button type="button" onClick={() => void copyAll()}>
          複製
        </button>
      </div>
      <div ref={containerRef} className="live-stream-body" role="log" aria-live="polite">
        {normalizedLines.length === 0 ? (
          <div className="live-stream-empty">尚無輸出</div>
        ) : (
          normalizedLines.map((tokens, lineIndex) => (
            <div key={`line-${lineIndex}`} className="live-stream-line">
              {tokens.map((token, tokenIndex) => (
                <span key={`token-${lineIndex}-${tokenIndex}`} className={token.className}>
                  {token.text}
                </span>
              ))}
            </div>
          ))
        )}
      </div>
      {copyMessage ? <p className="live-stream-msg">{copyMessage}</p> : null}
    </section>
  )
}

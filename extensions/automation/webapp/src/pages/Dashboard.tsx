import { useEffect, useMemo } from 'react'
import { useAppStore } from '../stores/app-store'
import './Dashboard.css'

const phaseLabelMap = {
  idle: { emoji: '🟢', label: '待命中' },
  running: { emoji: '🔄', label: '執行中' },
  waiting: { emoji: '🟡', label: '等待中' },
  error: { emoji: '🔴', label: '異常' },
} as const

const urgencyWeight = {
  high: 3,
  medium: 2,
  low: 1,
} as const

function getQuickActions(phase: keyof typeof phaseLabelMap): string[] {
  if (phase === 'running') {
    return ['查看輸出', '暫停任務', '快速回報']
  }
  if (phase === 'error') {
    return ['查看錯誤', '重試刷新', '建立修復任務']
  }
  if (phase === 'waiting') {
    return ['繼續執行', '切換 Agent', '檢查排程']
  }
  return ['刷新狀態', '啟動工作流', '查看任務佇列']
}

export function Dashboard() {
  const {
    phase,
    activeTask,
    attentionItems,
    stats,
    refreshAll,
  } = useAppStore((state) => ({
    phase: state.phase,
    activeTask: state.activeTask,
    attentionItems: state.attentionItems,
    stats: state.stats,
    refreshAll: state.refreshAll,
  }))

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  const sortedAttentionItems = useMemo(
    () =>
      [...attentionItems].sort(
        (a, b) => urgencyWeight[b.urgency] - urgencyWeight[a.urgency],
      ),
    [attentionItems],
  )

  const quickActions = getQuickActions(phase)
  const phaseInfo = phaseLabelMap[phase]
  const progress = activeTask ? Math.max(0, Math.min(100, activeTask.progress)) : 0

  return (
    <section className="dashboard">
      <header className="dashboard-card">
        <h1>首頁儀表板</h1>
        <p className="dashboard-phase">
          <span aria-hidden="true">{phaseInfo.emoji}</span>
          <span>{phaseInfo.label}</span>
        </p>
        <button type="button" className="dashboard-button" onClick={() => void refreshAll()}>
          下拉刷新
        </button>
      </header>

      <article className="dashboard-card">
        <h2>進行中任務</h2>
        {activeTask ? (
          <>
            <p className="task-title">{activeTask.title}</p>
            <div className="progress-track" aria-label="任務進度">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="task-progress">{progress}%</p>
          </>
        ) : (
          <p className="task-empty">目前沒有進行中任務。</p>
        )}
      </article>

      <article className="dashboard-card">
        <h2>注意事項</h2>
        {sortedAttentionItems.length > 0 ? (
          <ul className="attention-list">
            {sortedAttentionItems.map((item) => (
              <li key={item.id}>
                <span className={`urgency-dot urgency-${item.urgency}`} aria-hidden="true" />
                <span>{item.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="task-empty">目前無待處理警示。</p>
        )}
      </article>

      <article className="dashboard-card">
        <h2>快捷操作</h2>
        <div className="quick-actions">
          {quickActions.map((label) => (
            <button key={label} type="button" className="dashboard-button">
              {label}
            </button>
          ))}
        </div>
      </article>

      <footer className="dashboard-card dashboard-stats">
        <p>今日 Tokens：{stats.tokensToday}</p>
        <p>今日任務：{stats.tasksToday}</p>
      </footer>
    </section>
  )
}

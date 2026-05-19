import { useMemo } from 'react'
import './ProgressTracker.css'

export type ProgressStepState = 'pending' | 'running' | 'success' | 'failed'

export type ProgressStep = {
  id: string
  title: string
  state: ProgressStepState
  startedAt?: number
  endedAt?: number
}

type ProgressTrackerProps = {
  steps: ProgressStep[]
}

function stateEmoji(state: ProgressStepState): string {
  if (state === 'running') return '🔄'
  if (state === 'success') return '✅'
  if (state === 'failed') return '❌'
  return '⏳'
}

function stateClassName(state: ProgressStepState): string {
  if (state === 'running') return 'step-node step-running'
  if (state === 'success') return 'step-node step-success'
  if (state === 'failed') return 'step-node step-failed'
  return 'step-node step-pending'
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const remSec = Math.floor(sec % 60)
  return `${min}m ${remSec}s`
}

function durationText(step: ProgressStep): string {
  if (step.startedAt == null) return '未開始'
  if (step.endedAt == null) return '進行中'
  const duration = Math.max(0, step.endedAt - step.startedAt)
  return formatDurationMs(duration)
}

export function ProgressTracker({ steps }: ProgressTrackerProps) {
  const normalized = useMemo(() => steps, [steps])

  if (normalized.length === 0) {
    return <section className="progress-tracker-empty">尚無步驟資料</section>
  }

  return (
    <section className="progress-tracker">
      <ol className="progress-timeline">
        {normalized.map((step, index) => (
          <li key={step.id} className="progress-step">
            <div className="step-rail">
              <span className={stateClassName(step.state)}>{stateEmoji(step.state)}</span>
              {index < normalized.length - 1 ? <span className="step-line" aria-hidden="true" /> : null}
            </div>
            <div className="step-content">
              <h3>{step.title}</h3>
              <p>{durationText(step)}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

import { useMemo, useState } from 'react'
import './WorkflowEditor.css'

type StepState = 'pending' | 'running' | 'success' | 'failed'

type WorkflowStep = {
  id: string
  label: string
  state: StepState
}

type Workflow = {
  id: string
  name: string
  steps: WorkflowStep[]
}

const workflowTemplates: Workflow[] = [
  {
    id: 'auto-pr',
    name: 'auto-pr',
    steps: [
      { id: 'scan', label: '掃描變更', state: 'pending' },
      { id: 'test', label: '執行測試', state: 'pending' },
      { id: 'compose', label: '產生 PR 內容', state: 'pending' },
    ],
  },
  {
    id: 'code-review',
    name: 'code-review',
    steps: [
      { id: 'collect', label: '收集差異', state: 'pending' },
      { id: 'lint', label: '檢查規範', state: 'pending' },
      { id: 'report', label: '輸出審查報告', state: 'pending' },
    ],
  },
  {
    id: 'daily-scan',
    name: 'daily-scan',
    steps: [
      { id: 'inventory', label: '更新 inventory', state: 'pending' },
      { id: 'status', label: '檢查服務狀態', state: 'pending' },
      { id: 'notify', label: '整理通知摘要', state: 'pending' },
    ],
  },
  {
    id: 'refactor',
    name: 'refactor',
    steps: [
      { id: 'target', label: '選定模組', state: 'pending' },
      { id: 'patch', label: '套用重構補丁', state: 'pending' },
      { id: 'verify', label: '驗證與收斂', state: 'pending' },
    ],
  },
]

function stateIcon(state: StepState): string {
  if (state === 'running') return '🔄'
  if (state === 'success') return '✅'
  if (state === 'failed') return '❌'
  return '⏳'
}

function cloneWorkflows(): Workflow[] {
  return workflowTemplates.map((workflow) => ({
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
  }))
}

export function WorkflowEditor() {
  const [workflows, setWorkflows] = useState<Workflow[]>(() => cloneWorkflows())
  const [runningId, setRunningId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const workflowCount = useMemo(() => workflows.length, [workflows])

  async function runWorkflow(workflowId: string): Promise<void> {
    if (runningId) {
      return
    }

    setRunningId(workflowId)
    setMessage('')

    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === workflowId
          ? {
              ...workflow,
              steps: workflow.steps.map((step) => ({ ...step, state: 'pending' })),
            }
          : workflow,
      ),
    )

    const current = workflows.find((item) => item.id === workflowId)
    if (!current) {
      setRunningId(null)
      return
    }

    for (let index = 0; index < current.steps.length; index += 1) {
      setWorkflows((prev) =>
        prev.map((workflow) =>
          workflow.id === workflowId
            ? {
                ...workflow,
                steps: workflow.steps.map((step, stepIndex) => {
                  if (stepIndex < index) {
                    return { ...step, state: 'success' }
                  }
                  if (stepIndex === index) {
                    return { ...step, state: 'running' }
                  }
                  return { ...step, state: 'pending' }
                }),
              }
            : workflow,
        ),
      )
      await new Promise((resolve) => setTimeout(resolve, 450))
    }

    setWorkflows((prev) =>
      prev.map((workflow) =>
        workflow.id === workflowId
          ? {
              ...workflow,
              steps: workflow.steps.map((step) => ({ ...step, state: 'success' })),
            }
          : workflow,
      ),
    )

    setMessage(`工作流已完成：${workflowId}`)
    setRunningId(null)
  }

  return (
    <section className="workflow-editor">
      <header className="workflow-card">
        <h1>工作流管理</h1>
        <p>內建流程數：{workflowCount}</p>
      </header>

      {message ? <p className="workflow-message">{message}</p> : null}

      <div className="workflow-grid">
        {workflows.map((workflow) => (
          <article key={workflow.id} className="workflow-card">
            <div className="workflow-head">
              <h2>{workflow.name}</h2>
              <button
                type="button"
                disabled={Boolean(runningId)}
                onClick={() => void runWorkflow(workflow.id)}
              >
                執行
              </button>
            </div>
            <ol className="workflow-steps">
              {workflow.steps.map((step) => (
                <li key={step.id}>
                  <span aria-hidden="true">{stateIcon(step.state)}</span>
                  <span>{step.label}</span>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>
    </section>
  )
}

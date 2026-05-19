import { useEffect, useState } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import './DevOpsPanel.css'

type CiStatus = {
  repo: string
  branch: string
  state: string
}

type PullRequestInfo = {
  number: number
  title: string
  state: string
  draft: boolean
}

function toCiStatus(value: unknown): CiStatus {
  if (!value || typeof value !== 'object') {
    return { repo: 'unknown', branch: 'main', state: 'unknown' }
  }
  const record = value as Record<string, unknown>
  return {
    repo: typeof record.repo === 'string' ? record.repo : 'unknown',
    branch: typeof record.branch === 'string' ? record.branch : 'main',
    state: typeof record.state === 'string' ? record.state : 'unknown',
  }
}

function toPullRequest(value: unknown): PullRequestInfo {
  if (!value || typeof value !== 'object') {
    return { number: 0, title: 'unknown', state: 'unknown', draft: false }
  }
  const record = value as Record<string, unknown>
  return {
    number: typeof record.number === 'number' ? record.number : 0,
    title: typeof record.title === 'string' ? record.title : 'unknown',
    state: typeof record.state === 'string' ? record.state : 'unknown',
    draft: typeof record.draft === 'boolean' ? record.draft : false,
  }
}

function statusEmoji(state: string): string {
  const normalized = state.toLowerCase()
  if (normalized.includes('pass') || normalized.includes('success') || normalized.includes('ok')) {
    return '✅'
  }
  if (normalized.includes('run') || normalized.includes('pending')) {
    return '🔄'
  }
  if (normalized.includes('fail') || normalized.includes('error')) {
    return '❌'
  }
  return '⚪'
}

export function DevOpsPanel() {
  const [ciStatuses, setCiStatuses] = useState<CiStatus[]>([])
  const [pullRequests, setPullRequests] = useState<PullRequestInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  async function refreshData() {
    setLoading(true)
    setMessage('')
    const client = createGatewayWsRpcClient()
    try {
      await client.connect()
      const [ciRaw, prRaw] = await Promise.all([
        client.call('ci.statuses'),
        client.call('github.prs.list'),
      ])

      const ciList = Array.isArray(ciRaw) ? ciRaw.map(toCiStatus) : []
      const prList = Array.isArray(prRaw) ? prRaw.map(toPullRequest) : []

      setCiStatuses(ciList)
      setPullRequests(prList)
    } catch {
      setMessage('讀取 DevOps 資料失敗，請確認 Gateway 是否可用。')
    } finally {
      client.disconnect()
      setLoading(false)
    }
  }

  useEffect(() => {
    void refreshData()
  }, [])

  function handleDeployConfirm() {
    const accepted = window.confirm('確認要執行部署動作？此操作屬高風險。')
    setMessage(accepted ? '部署請求已送出（示意流程）。' : '已取消部署操作。')
  }

  return (
    <section className="devops-panel">
      <header className="devops-card">
        <h1>DevOps 面板</h1>
        <button type="button" className="devops-btn-primary" disabled={loading} onClick={() => void refreshData()}>
          刷新資料
        </button>
      </header>

      {message ? <p className="devops-message">{message}</p> : null}

      <article className="devops-card">
        <h2>CI/CD 狀態</h2>
        {ciStatuses.length === 0 ? (
          <p>目前沒有 CI 資料。</p>
        ) : (
          <ul className="devops-list">
            {ciStatuses.map((item, idx) => (
              <li key={`${item.repo}-${item.branch}-${idx}`}>
                <span className="devops-emoji" aria-hidden="true">
                  {statusEmoji(item.state)}
                </span>
                <span>{item.repo}</span>
                <span>{item.branch}</span>
                <span>{item.state}</span>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="devops-card">
        <h2>Pull Requests</h2>
        {pullRequests.length === 0 ? (
          <p>目前沒有 PR 資料。</p>
        ) : (
          <ul className="devops-list">
            {pullRequests.map((pr) => (
              <li key={pr.number}>
                <span className="devops-emoji" aria-hidden="true">
                  {pr.draft ? '🟡' : '🟢'}
                </span>
                <span>#{pr.number}</span>
                <span>{pr.title}</span>
                <span>{pr.state}</span>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="devops-card">
        <h2>部署確認</h2>
        <button type="button" className="devops-btn-danger" onClick={handleDeployConfirm}>
          執行部署（Danger）
        </button>
      </article>
    </section>
  )
}

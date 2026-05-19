import { useEffect, useMemo, useState } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import { useAppStore } from '../stores/app-store'
import './CronManager.css'

export function CronManager() {
  const { cronJobs, refreshAll } = useAppStore((state) => ({
    cronJobs: state.cronJobs,
    refreshAll: state.refreshAll,
  }))
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (cronJobs.length === 0) {
      void refreshAll()
    }
  }, [cronJobs.length, refreshAll])

  const orderedJobs = useMemo(
    () => [...cronJobs].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant', { sensitivity: 'base' })),
    [cronJobs],
  )

  async function toggleCron(id: string, enabled: boolean) {
    setBusy(id)
    setMessage('')
    const client = createGatewayWsRpcClient()

    try {
      await client.connect()
      await client.call('cron.update', { id, enabled })
      await refreshAll()
      setMessage(`排程已${enabled ? '啟用' : '停用'}：${id}`)
    } catch {
      setMessage(`排程切換失敗：${id}`)
    } finally {
      client.disconnect()
      setBusy(null)
    }
  }

  async function runCronNow(id: string) {
    setBusy(id)
    setMessage('')
    const client = createGatewayWsRpcClient()

    try {
      await client.connect()
      await client.call('cron.run', { id })
      setMessage(`已觸發立即執行：${id}`)
    } catch {
      setMessage(`立即執行失敗：${id}`)
    } finally {
      client.disconnect()
      setBusy(null)
    }
  }

  return (
    <section className="cron-manager">
      <header className="cron-card">
        <h1>排程管理</h1>
        <button type="button" className="cron-btn-primary" disabled={Boolean(busy)} onClick={() => void refreshAll()}>
          刷新列表
        </button>
      </header>

      {message ? <p className="cron-message">{message}</p> : null}

      {orderedJobs.length === 0 ? (
        <article className="cron-card">
          <p>目前沒有可用排程。</p>
        </article>
      ) : (
        <div className="cron-grid">
          {orderedJobs.map((job) => (
            <article key={job.id} className="cron-card">
              <div className="cron-head">
                <h2>{job.name}</h2>
                <label className="cron-switch">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    disabled={busy === job.id}
                    onChange={(event) => void toggleCron(job.id, event.target.checked)}
                  />
                  <span>{job.enabled ? '啟用' : '停用'}</span>
                </label>
              </div>
              <p className="cron-meta">ID：{job.id}</p>
              <p className="cron-meta">排程：{job.schedule}</p>
              <button
                type="button"
                className="cron-btn-secondary"
                disabled={busy === job.id}
                onClick={() => void runCronNow(job.id)}
              >
                立即執行
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

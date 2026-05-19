import { useEffect, useMemo, useState } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import { useAppStore } from '../stores/app-store'
import './StatusBar.css'

export function StatusBar() {
  const { stats, agents } = useAppStore((state) => ({
    stats: state.stats,
    agents: state.agents,
  }))

  const [connected, setConnected] = useState(false)

  useEffect(() => {
    const client = createGatewayWsRpcClient()
    let closed = false

    void (async () => {
      try {
        await client.connect()
        if (!closed) {
          setConnected(true)
        }
      } catch {
        if (!closed) {
          setConnected(false)
        }
      }
    })()

    return () => {
      closed = true
      client.disconnect()
    }
  }, [])

  const agentSummary = useMemo(() => {
    if (agents.length === 0) {
      return '無 Agent 資料'
    }
    const onlineCount = agents.filter((item) => {
      const status = item.status.toLowerCase()
      return !status.includes('off') && !status.includes('error')
    }).length
    return `${onlineCount}/${agents.length} 在線`
  }, [agents])

  return (
    <section className="status-bar">
      <div className="status-item">
        <span className={connected ? 'status-dot is-online' : 'status-dot is-offline'} />
        <span>WebSocket：{connected ? '已連線' : '未連線'}</span>
      </div>
      <div className="status-item">
        <span>Tokens：{stats.tokensToday}</span>
        <span>Tasks：{stats.tasksToday}</span>
      </div>
      <div className="status-item">
        <span>Agent：{agentSummary}</span>
      </div>
    </section>
  )
}

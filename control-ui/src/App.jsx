import React, { useState, useEffect, useRef } from 'react'
import './App.css'

const normalizeApiBaseUrl = (value = '') => value.replace(/\/+$/u, '').replace(/\/api$/u, '')
const configuredApiBaseUrl = normalizeApiBaseUrl(import.meta.env.VITE_API_URL || '')
const configuredWsBaseUrl = (import.meta.env.VITE_WS_URL || '').replace(/\/+$/u, '')
const preferSameOriginApi = import.meta.env.DEV || !configuredApiBaseUrl

const AI_REPO_MARKERS = [
  'api.github.com/repos/pytorch/pytorch',
  'api.github.com/repos/huggingface/transformers',
  'api.github.com/repos/langchain-ai/langchain',
  'api.github.com/repos/Significant-Gravitas/Auto-GPT',
  'api.github.com/repos/hwchase17/langchain',
  'api.github.com/repos/karpathy/nanoGPT',
  'api.github.com/repos/google/jax',
  'api.github.com/repos/openai/whisper',
  'api.github.com/repos/openai/openai-python',
  'api.github.com/repos/vllm-project/vllm',
  'api.github.com/repos/run-llama/llama_index',
  'api.github.com/repos/ollama/ollama',
  'api.github.com/repos/scikit-learn/scikit-learn',
  'api.github.com/repos/keras-team/keras',
  'api.github.com/repos/deepspeedai/DeepSpeed',
  'api.github.com/repos/mlflow/mlflow',
  'api.github.com/repos/triton-lang/triton',
  'api.github.com/repos/lm-sys/FastChat',
  'api.github.com/repos/Lightning-AI/pytorch-lightning',
  'api.github.com/repos/microsoft/onnxruntime',
  'huggingface.co/api/models/meta-llama/Meta-Llama-3-8B',
  'huggingface.co/api/models/meta-llama/Meta-Llama-3-8B-Instruct',
  'huggingface.co/api/models/gradientai/Llama-3-8B-Instruct-262k',
  'huggingface.co/api/models/QuantFactory/Meta-Llama-3-8B-GGUF',
  'huggingface.co/api/models/NousResearch/Hermes-2-Pro-Llama-3-8B',
  'huggingface.co/api/models/zaya-ai/zaya-1-8b'
]

const isAiRepoTarget = (url = '') => AI_REPO_MARKERS.some(marker => url.includes(marker))
const buildApiUrl = (path) => preferSameOriginApi ? path : `${configuredApiBaseUrl}${path}`

const buildWebSocketUrl = (path) => {
  if (preferSameOriginApi) {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${wsProtocol}//${window.location.host}${path}`
  }

  if (configuredWsBaseUrl) {
    return `${configuredWsBaseUrl}${path}`
  }

  if (configuredApiBaseUrl) {
    const url = new URL(buildApiUrl(path), window.location.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
  }

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${window.location.host}${path}`
}

function App() {
  const [logs, setLogs] = useState([])
  const [targets, setTargets] = useState([])
  const [stats, setStats] = useState({ workers: 0, active: 0, completed: 0, failed: 0 })
  const [githubStatus, setGitHubStatus] = useState({ tokenPresent: false, authMode: 'public', rateLimit: null, lastError: null, lastUpdated: null })
  const [isPaused, setIsPaused] = useState(false)
  const logsEndRef = useRef(null)
  const wsRef = useRef(null)
  const nextLogIdRef = useRef(0)
  const visibleTargets = targets.filter(target => target.status !== 'failed' && isAiRepoTarget(target.url || ''))
  const successfulAiTargets = visibleTargets.filter(target => target.status === 'completed').length
  const githubRateRemaining = githubStatus.rateLimit?.remaining ?? '--'
  const githubAuthLabel = githubStatus.tokenPresent ? 'AUTH' : 'PUBLIC'

  const refreshDashboard = async () => {
    const [targetsResult, githubResult] = await Promise.allSettled([
      fetch(buildApiUrl('/api/targets')),
      fetch(buildApiUrl('/api/github/status'))
    ])

    if (targetsResult.status === 'fulfilled') {
      const response = targetsResult.value
      if (response.ok) {
        const data = await response.json()
        setTargets(data.targets || [])
        setStats(data.stats || stats)
      }
    } else {
      console.error('Failed to fetch targets:', targetsResult.reason)
    }

    if (githubResult.status === 'fulfilled') {
      const response = githubResult.value
      if (response.ok) {
        const data = await response.json()
        setGitHubStatus(data)
      }
    } else {
      console.error('Failed to fetch GitHub status:', githubResult.reason)
    }
  }

  // Auto-scroll til að sjá nýjustu logs
  const scrollToBottom = () => {
    if (!isPaused) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }

  useEffect(() => {
    scrollToBottom()
  }, [logs])

  // Fetch targets list
  useEffect(() => {
    refreshDashboard()
    const interval = setInterval(refreshDashboard, 5000) // Update every 5s

    return () => clearInterval(interval)
  }, [])

  // WebSocket fyrir rauntíma logs
  useEffect(() => {
    const connectWebSocket = () => {
      const ws = new WebSocket(buildWebSocketUrl('/api/logs/stream'))

      ws.onopen = () => {
        console.log('🟢 WebSocket connected')
        addLog({ level: 'success', message: 'Connected to Harvester log stream', timestamp: new Date().toISOString() })
      }

      ws.onmessage = (event) => {
        try {
          const logEntry = JSON.parse(event.data)
          addLog(logEntry)
        } catch (error) {
          console.error('Failed to parse log:', error)
        }
      }

      ws.onerror = (error) => {
        console.error('WebSocket error:', error)
      }

      ws.onclose = () => {
        console.log('🔴 WebSocket disconnected, reconnecting...')
        setTimeout(connectWebSocket, 3000) // Reconnect after 3s
      }

      wsRef.current = ws
    }

    connectWebSocket()

    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, [])

  const addLog = (logEntry) => {
    setLogs(prev => {
      const logId = `${Date.now()}-${nextLogIdRef.current++}`
      const newLogs = [...prev, { ...logEntry, id: logId }]
      // Keep only last 500 logs
      return newLogs.slice(-500)
    })
  }

  const clearLogs = () => {
    setLogs([])
  }

  const cleanupTargets = async () => {
    try {
      const response = await fetch(buildApiUrl('/api/targets/cleanup-failed'), { method: 'POST' })
      if (!response.ok) {
        throw new Error(`Cleanup failed: ${response.status}`)
      }

      const data = await response.json()
      setTargets(data.targets || [])
      setStats(data.stats || stats)
      await refreshDashboard()
      addLog({ level: 'warning', message: `Cleanup removed ${data.removed ?? 0} failed targets`, timestamp: new Date().toISOString() })
    } catch (error) {
      console.error('Failed to cleanup targets:', error)
      addLog({ level: 'error', message: `Cleanup failed: ${error.message}`, timestamp: new Date().toISOString() })
    }
  }

  const getLogColor = (level) => {
    const colors = {
      info: '#00b4ff',
      success: '#00ff88',
      warning: '#ffaa00',
      error: '#ff3366',
      debug: '#9966ff'
    }
    return colors[level] || '#ffffff'
  }

  const getTargetStatus = (target) => {
    if (target.status === 'active') return '🟢'
    if (target.status === 'completed') return '✅'
    if (target.status === 'failed') return '❌'
    if (target.status === 'pending') return '⏳'
    return '⚪'
  }

  return (
    <div className="app">
      {/* HEADER */}
      <header className="header">
        <div className="header-left">
          <h1 className="title glow">🐺 ALPHABET HARVESTER</h1>
          <div className="subtitle">Rauntíma Stjórnstöð</div>
        </div>
        <div className="header-right">
          <div className="stat-card">
            <div className="stat-label">Workers</div>
            <div className="stat-value pulse">{stats.workers}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Active</div>
            <div className="stat-value" style={{ color: '#00ff88' }}>{stats.active}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Completed</div>
            <div className="stat-value" style={{ color: '#00b4ff' }}>{stats.completed}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">AI Success</div>
            <div className="stat-value" style={{ color: '#00ff88' }}>{successfulAiTargets}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">GitHub Auth</div>
            <div className="stat-value" style={{ color: githubStatus.tokenPresent ? '#00ff88' : '#ffaa00', fontSize: '1.1rem' }}>{githubAuthLabel}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Rate Left</div>
            <div className="stat-value" style={{ color: '#7dd3c0' }}>{githubRateRemaining}</div>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* TARGETS PANEL */}
        <aside className="targets-panel">
          <div className="panel-header">
            <h2>🤖 AI Targets ({visibleTargets.length})</h2>
          </div>
          <div className="targets-list">
            {visibleTargets.length === 0 ? (
              <div className="empty-state">Engin virk AI targets fundust</div>
            ) : (
              visibleTargets.map((target, idx) => (
                <div key={idx} className="target-item" title={target.url}>
                  <span className="target-status">{getTargetStatus(target)}</span>
                  <span className="target-url">{target.url || target.name}</span>
                  {target.progress && (
                    <span className="target-progress">{target.progress}%</span>
                  )}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* LOG FEED */}
        <main className="log-panel">
          <div className="panel-header">
            <h2>📡 Live Log Feed</h2>
            <div className="log-controls">
              <button
                className="btn btn-secondary"
                onClick={() => setIsPaused(!isPaused)}
              >
                {isPaused ? '▶️ Resume' : '⏸️ Pause'}
              </button>
              <button className="btn btn-secondary" onClick={cleanupTargets}>
                🧹 Cleanup
              </button>
              <button className="btn btn-danger" onClick={clearLogs}>
                🗑️ Clear
              </button>
            </div>
          </div>
          <div className="logs-container">
            {logs.length === 0 ? (
              <div className="empty-state">Waiting for logs...</div>
            ) : (
              logs.map(log => (
                <div key={log.id} className="log-entry">
                  <span className="log-timestamp">{new Date(log.timestamp).toLocaleTimeString('is-IS')}</span>
                  <span
                    className="log-level"
                    style={{ color: getLogColor(log.level) }}
                  >
                    [{log.level?.toUpperCase() || 'INFO'}]
                  </span>
                  <span className="log-message">{log.message}</span>
                </div>
              ))
            )}
            <div ref={logsEndRef} />
          </div>
        </main>
      </div>

      {/* FOOTER */}
      <footer className="footer">
        <div className="footer-left">
          <span className="pulse" style={{ color: '#00ff88' }}>●</span> LIVE
        </div>
        <div className="footer-center">
          OpenClaw Harvester Engine v1.0 | Port 8080
        </div>
        <div className="footer-right">
          🇮🇸 Íslensk Útgáfa
        </div>
      </footer>
    </div>
  )
}

export default App

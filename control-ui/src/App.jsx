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

const toBinaryMetric = (value) => value ? '1' : '0'

const buildStripeWorker = (stripeStatus) => {
  if (!stripeStatus) {
    return null
  }

  const tone = stripeStatus.lastError ? 'error' : stripeStatus.secretConfigured ? 'ok' : 'warn'
  const statusLabel = stripeStatus.lastError ? 'ERROR' : stripeStatus.secretConfigured ? 'ARMED' : 'IDLE'

  return {
    id: 'stripe',
    icon: '💳',
    label: 'Stripe',
    tone,
    statusLabel,
    summary: stripeStatus.businessName || stripeStatus.accountId || stripeStatus.apiBaseUrl || 'Stripe API',
    detail: stripeStatus.lastError || `${stripeStatus.livemode ? 'LIVE' : 'TEST'} · ${stripeStatus.keyVaultName || 'no-vault'}`,
    metrics: [
      { label: 'Rows', value: String(stripeStatus.persistedCount ?? 0) },
      { label: 'Queued', value: String(stripeStatus.lastSyncQueued ?? 0) },
      { label: 'Charge', value: toBinaryMetric(stripeStatus.chargesEnabled) },
      { label: 'Payout', value: toBinaryMetric(stripeStatus.payoutsEnabled) }
    ]
  }
}

const buildRevolutWorker = (revolutStatus) => {
  if (!revolutStatus) {
    return null
  }

  const readyCount = Number(Boolean(revolutStatus.signerConfigured)) + Number(Boolean(revolutStatus.refreshTokenPresent))
  const tone = revolutStatus.lastError ? 'error' : revolutStatus.configured ? 'ok' : 'warn'
  const statusLabel = revolutStatus.lastError ? 'ERROR' : revolutStatus.configured ? 'ARMED' : 'IDLE'

  return {
    id: 'revolut',
    icon: '🏦',
    label: 'Revolut',
    tone,
    statusLabel,
    summary: revolutStatus.signerBaseUrl || revolutStatus.revolutBaseUrl || 'Revolut signer',
    detail: revolutStatus.lastError || `${revolutStatus.clientIdMode || 'jwt-sub'} · ${revolutStatus.signerPath || '/internal/auth/revolut/client-assertion'}`,
    metrics: [
      { label: 'Ready', value: `${readyCount}/2` },
      { label: 'Access', value: toBinaryMetric(revolutStatus.accessTokenPresent) },
      { label: 'Client', value: toBinaryMetric(revolutStatus.clientIdPresent) },
      { label: 'Refresh', value: revolutStatus.lastRefreshStatus ? String(revolutStatus.lastRefreshStatus) : '--' }
    ]
  }
}

const getFinanceStatusTone = (value = '') => {
  const normalizedValue = String(value).toLowerCase()

  if (['completed', 'settled', 'captured', 'paid', 'authorised', 'authorized', 'success'].some((token) => normalizedValue.includes(token))) {
    return 'ok'
  }

  if (['failed', 'error', 'declined', 'cancelled', 'canceled', 'reversed'].some((token) => normalizedValue.includes(token))) {
    return 'error'
  }

  return 'warn'
}

const formatExecutiveValue = (value, fallback = '--') => value || fallback

const formatExecutiveTimestamp = (value) => {
  if (!value) {
    return '--'
  }

  const timestamp = new Date(value)

  if (Number.isNaN(timestamp.getTime())) {
    return '--'
  }

  return timestamp.toLocaleString('is-IS', {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

const formatCurrencyValue = (value, currency = 'EUR') => {
  if (!Number.isFinite(value)) {
    return '--'
  }

  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value)
  } catch {
    return `${value.toLocaleString('en-IE', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    })} ${currency}`
  }
}

const formatCompactCurrencyValue = (value, currency = 'EUR') => {
  if (!Number.isFinite(value)) {
    return '--'
  }

  try {
    return new Intl.NumberFormat('en-IE', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 2
    }).format(value)
  } catch {
    return formatCurrencyValue(value, currency)
  }
}

const formatNumberValue = (value, maximumFractionDigits = 2) => {
  if (!Number.isFinite(value)) {
    return '--'
  }

  return new Intl.NumberFormat('en-IE', {
    minimumFractionDigits: 0,
    maximumFractionDigits
  }).format(value)
}

const getEmpireAssetBySymbol = (empireMarket, symbol) => {
  const assets = empireMarket?.market?.assets || []

  return assets.find((asset) => asset.symbol === symbol) || null
}

const formatConfiguredAssetHoldings = (asset) => {
  if (!asset) {
    return '--'
  }

  if (!asset.holdingsConfigured && Number(asset.holdings || 0) === 0) {
    return `Awaiting ${asset.symbol} balance`
  }

  return `${asset.holdingsDisplay || formatNumberValue(asset.holdings, 4)} ${asset.symbol}`
}

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
  const [stripeStatus, setStripeStatus] = useState(null)
  const [revolutStatus, setRevolutStatus] = useState(null)
  const [revolutMerchantEvents, setRevolutMerchantEvents] = useState({ events: [], summary: null, database: null })
  const [empireMarket, setEmpireMarket] = useState({ market: null, paypalRecovery: null, revolut: null, summary: null, database: null, empire: null })
  const [isPaused, setIsPaused] = useState(false)
  const logsEndRef = useRef(null)
  const wsRef = useRef(null)
  const nextLogIdRef = useRef(0)
  const visibleTargets = targets.filter(target => target.status !== 'failed' && isAiRepoTarget(target.url || ''))
  const financeWorkers = [buildStripeWorker(stripeStatus), buildRevolutWorker(revolutStatus)].filter(Boolean)
  const stripeRows = stripeStatus?.persistedCount ?? 0
  const executiveEvents = revolutMerchantEvents.events || []
  const executiveSummary = revolutMerchantEvents.summary
  const empireSummary = empireMarket.summary
  const bitcoinAsset = getEmpireAssetBySymbol(empireMarket, 'BTC')
  const ethereumAsset = getEmpireAssetBySymbol(empireMarket, 'ETH')
  const piAsset = getEmpireAssetBySymbol(empireMarket, 'PI')
  const revolutGrossValue = Number(executiveSummary?.totalAmountValue ?? empireMarket.revolut?.totalAmountValue ?? 0)
  const revolutRows = revolutMerchantEvents.summary?.persistedCount ?? revolutStatus?.persistedCount ?? 0
  const revolutGrossDisplay = executiveSummary?.totalAmountDisplay || empireMarket.revolut?.totalAmountDisplay || revolutStatus?.lastAmountDisplay || '--'
  const revolutReady = revolutStatus
    ? `${Number(Boolean(revolutStatus.signerConfigured)) + Number(Boolean(revolutStatus.refreshTokenPresent))}/2`
    : '--'
  const githubAuthLabel = githubStatus.tokenPresent ? 'AUTH' : 'PUBLIC'
  const cryptoStackDisplay = empireSummary?.cryptoValueDisplay || '--'
  const btcBackstopValue = bitcoinAsset?.valueEur ?? null
  const paypalRecovery = empireMarket.paypalRecovery
  const totalAlphabetNetWorth = empireSummary?.totalNetWorthEur ?? [bitcoinAsset?.valueEur, ethereumAsset?.valueEur, piAsset?.valueEur, revolutGrossValue, paypalRecovery?.targetValueEur]
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value, 0)
  const totalAlphabetNetWorthDisplay = empireSummary?.totalNetWorthDisplay || formatCurrencyValue(totalAlphabetNetWorth, 'EUR')

  const refreshDashboard = async () => {
    const [targetsResult, githubResult, stripeResult, revolutResult, revolutMerchantEventsResult, empireMarketResult] = await Promise.allSettled([
      fetch(buildApiUrl('/api/targets')),
      fetch(buildApiUrl('/api/github/status')),
      fetch(buildApiUrl('/api/stripe/status')),
      fetch(buildApiUrl('/api/revolut/status')),
      fetch(buildApiUrl('/api/revolut/merchant-events?limit=8')),
      fetch(buildApiUrl('/api/empire/market'))
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

    if (stripeResult.status === 'fulfilled') {
      const response = stripeResult.value
      if (response.ok) {
        const data = await response.json()
        setStripeStatus(data)
      }
    } else {
      console.error('Failed to fetch Stripe status:', stripeResult.reason)
    }

    if (revolutResult.status === 'fulfilled') {
      const response = revolutResult.value
      if (response.ok) {
        const data = await response.json()
        setRevolutStatus(data)
      }
    } else {
      console.error('Failed to fetch Revolut status:', revolutResult.reason)
    }

    if (revolutMerchantEventsResult.status === 'fulfilled') {
      const response = revolutMerchantEventsResult.value
      if (response.ok) {
        const data = await response.json()
        setRevolutMerchantEvents({
          events: data.events || [],
          summary: data.summary || null,
          database: data.database || null
        })
      }
    } else {
      console.error('Failed to fetch Revolut merchant events:', revolutMerchantEventsResult.reason)
    }

    if (empireMarketResult.status === 'fulfilled') {
      const response = empireMarketResult.value
      if (response.ok) {
        const data = await response.json()
        setEmpireMarket({
          market: data.market || null,
          paypalRecovery: data.paypalRecovery || null,
          revolut: data.revolut || null,
          summary: data.summary || null,
          database: data.database || null,
          empire: data.empire || null
        })
      }
    } else {
      console.error('Failed to fetch empire market data:', empireMarketResult.reason)
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
          <div className="empire-banner">
            <span className="empire-banner-label">Alphabet Net Worth</span>
            <strong className="empire-banner-value">{totalAlphabetNetWorthDisplay}</strong>
            <span className="empire-banner-detail">
              Harvester-fed BTC + ETH + PI + Revolut + PayPal model
            </span>
          </div>
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
            <div className="stat-label">Stripe Rows</div>
            <div className="stat-value" style={{ color: '#00ff88' }}>{stripeRows}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Revolut Rows</div>
            <div className="stat-value" style={{ color: '#7dd3c0' }}>{revolutRows}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">GitHub Auth</div>
            <div className="stat-value" style={{ color: githubStatus.tokenPresent ? '#00ff88' : '#ffaa00', fontSize: '1.1rem' }}>{githubAuthLabel}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Revolut Ready</div>
            <div className="stat-value" style={{ color: '#7dd3c0', fontSize: '1.1rem' }}>{revolutReady}</div>
          </div>
          <div className="stat-card stat-card--wide">
            <div className="stat-label">Revolut Gross</div>
            <div className="stat-value stat-value--compact" style={{ color: '#7dd3c0' }}>{revolutGrossDisplay}</div>
          </div>
          <div className="stat-card stat-card--wide stat-card--accent">
            <div className="stat-label">BTC Backstop</div>
            <div className="stat-value stat-value--compact" style={{ color: '#fbbf24' }}>{bitcoinAsset?.valueDisplay || formatCompactCurrencyValue(btcBackstopValue, 'EUR')}</div>
          </div>
          <div className="stat-card stat-card--wide stat-card--accent">
            <div className="stat-label">Digital Assets</div>
            <div className="stat-value stat-value--compact" style={{ color: '#93c5fd' }}>{cryptoStackDisplay}</div>
          </div>
          <div className="stat-card stat-card--wide stat-card--accent">
            <div className="stat-label">PayPal Recovery</div>
            <div className="stat-value stat-value--compact" style={{ color: '#93c5fd' }}>{paypalRecovery?.targetValueDisplay || '--'}</div>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-row">
          {/* TARGETS PANEL */}
          <aside className="targets-panel">
            <div className="panel-header">
              <div>
                <h2>💼 Finance Workers ({financeWorkers.length})</h2>
                <div className="panel-subtitle">Stripe og Revolut live runtime</div>
              </div>
            </div>
            <div className="targets-list">
              {financeWorkers.length === 0 ? (
                <div className="empty-state">Bíð eftir Stripe/Revolut stöðu...</div>
              ) : (
                financeWorkers.map((worker) => (
                  <div key={worker.id} className="target-item target-item--finance" title={worker.summary}>
                    <span className="target-status">{worker.icon}</span>
                    <div className="target-body">
                      <div className="target-row">
                        <span className="target-url">{worker.label}</span>
                        <span className={`status-chip status-chip--${worker.tone}`}>{worker.statusLabel}</span>
                      </div>
                      <div className="target-meta">{worker.summary}</div>
                      <div className="target-metrics">
                        {worker.metrics.map((metric) => (
                          <div key={`${worker.id}-${metric.label}`} className="target-metric">
                            <span>{metric.label}</span>
                            <strong>{metric.value}</strong>
                          </div>
                        ))}
                      </div>
                      <div className="target-detail">{worker.detail}</div>
                    </div>
                  </div>
                ))
              )}
              {visibleTargets.length > 0 && (
                <div className="targets-secondary-block">
                  <div className="targets-secondary-title">🤖 AI Targets ({visibleTargets.length})</div>
                  {visibleTargets.map((target, idx) => (
                    <div key={`${target.url || target.name}-${idx}`} className="target-item" title={target.url}>
                      <span className="target-status">{getTargetStatus(target)}</span>
                      <span className="target-url">{target.url || target.name}</span>
                      {target.progress && (
                        <span className="target-progress">{target.progress}%</span>
                      )}
                    </div>
                  ))}
                </div>
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

        <section className="executive-panel">
          <div className="panel-header">
            <div>
              <h2>💶 Revolut Executive View</h2>
              <div className="panel-subtitle">Gross EUR, settlements, merchant references, and customer visibility</div>
            </div>
            <div className="executive-panel-meta">
              <span>{`${executiveSummary?.persistedCount ?? 0} persisted merchant events`}</span>
              <strong>{formatExecutiveTimestamp(executiveSummary?.latestReceivedAt)}</strong>
            </div>
          </div>
          <div className="executive-panel-content">
            <div className="executive-block">
              <div className="empire-grid">
                <article className="empire-card empire-card--btc">
                  <div className="empire-card-header">
                    <span>₿ Bitcoin Backstop</span>
                    <strong>{formatConfiguredAssetHoldings(bitcoinAsset)}</strong>
                  </div>
                  <div className="empire-card-value">{bitcoinAsset?.valueDisplay || '--'}</div>
                  <div className="empire-card-meta">
                    <span>{bitcoinAsset?.priceDisplay ? `Spot: ${bitcoinAsset.priceDisplay} / BTC` : 'Awaiting Harvester quote'}</span>
                    <span>{empireMarket.market?.source ? `${empireMarket.market.source} · ${formatExecutiveTimestamp(empireMarket.market.fetchedAt)}` : 'Awaiting Harvester market feed'}</span>
                  </div>
                </article>

                <article className="empire-card empire-card--eth">
                  <div className="empire-card-header">
                    <span>Ξ Ethereum Stack</span>
                    <strong>{formatConfiguredAssetHoldings(ethereumAsset)}</strong>
                  </div>
                  <div className="empire-card-value">{ethereumAsset?.valueDisplay || '--'}</div>
                  <div className="empire-card-meta">
                    <span>{ethereumAsset?.priceDisplay ? `Spot: ${ethereumAsset.priceDisplay} / ETH` : 'Awaiting Harvester quote'}</span>
                    <span>{ethereumAsset?.holdingsConfigured ? `Holdings live in empire math` : 'Configure via ALPHABET_ETH_HOLDINGS'}</span>
                  </div>
                </article>

                <article className="empire-card empire-card--pi">
                  <div className="empire-card-header">
                    <span>◉ Pi Reserve</span>
                    <strong>{formatConfiguredAssetHoldings(piAsset)}</strong>
                  </div>
                  <div className="empire-card-value">{piAsset?.valueDisplay || '--'}</div>
                  <div className="empire-card-meta">
                    <span>{piAsset?.priceDisplay ? `Spot: ${piAsset.priceDisplay} / PI` : 'Awaiting Harvester quote'}</span>
                    <span>{piAsset?.holdingsConfigured ? `Holdings live in empire math` : 'Configure via ALPHABET_PI_HOLDINGS'}</span>
                  </div>
                </article>

                <article className="empire-card empire-card--paypal">
                  <div className="empire-card-header">
                    <span>🧾 PayPal Recovery</span>
                    <strong>{paypalRecovery?.countdownLabel || '--'}</strong>
                  </div>
                  <div className="empire-card-value">{paypalRecovery?.targetValueDisplay || '--'}</div>
                  <div className="empire-card-meta empire-card-meta--stacked">
                    <span>Principal: {paypalRecovery?.principalDisplay || '--'}</span>
                    <span>Interest @ {Number.isFinite(paypalRecovery?.apr) ? formatNumberValue(paypalRecovery.apr * 100, 2) : '--'}% APR: {paypalRecovery?.accruedInterestDisplay || '--'}</span>
                    <span>Target date: {formatExecutiveTimestamp(paypalRecovery?.targetDate)}</span>
                  </div>
                </article>

                <article className="empire-card empire-card--networth">
                  <div className="empire-card-header">
                    <span>👑 Empire Total</span>
                    <strong>EUR</strong>
                  </div>
                  <div className="empire-card-value">{totalAlphabetNetWorthDisplay}</div>
                  <div className="empire-card-meta empire-card-meta--stacked">
                    <span>BTC: {bitcoinAsset?.valueDisplay || '--'}</span>
                    <span>ETH: {ethereumAsset?.valueDisplay || '--'}</span>
                    <span>PI: {piAsset?.valueDisplay || '--'}</span>
                    <span>Revolut: {revolutGrossDisplay}</span>
                    <span>PayPal: {paypalRecovery?.targetValueDisplay || '--'}</span>
                  </div>
                </article>
              </div>

              <div className="executive-metrics">
                <div className="executive-metric">
                  <span>Gross EUR</span>
                  <strong>{formatExecutiveValue(executiveSummary?.totalAmountDisplay, revolutGrossDisplay)}</strong>
                </div>
                <div className="executive-metric">
                  <span>Settled EUR</span>
                  <strong>{formatExecutiveValue(executiveSummary?.totalSettlementAmountDisplay || executiveSummary?.latestSettlementAmountDisplay)}</strong>
                </div>
                <div className="executive-metric">
                  <span>Customer Emails</span>
                  <strong>{executiveSummary?.customerEmailCount ?? 0}</strong>
                </div>
                <div className="executive-metric">
                  <span>Latest Customer</span>
                  <strong>{formatExecutiveValue(executiveSummary?.latestCustomerEmail, 'Awaiting merchant email')}</strong>
                </div>
                <div className="executive-metric">
                  <span>Merchant Ref</span>
                  <strong>{formatExecutiveValue(executiveSummary?.latestMerchantReference, 'Awaiting merchant reference')}</strong>
                </div>
                <div className="executive-metric">
                  <span>Latest Event</span>
                  <strong>{formatExecutiveValue(executiveSummary?.latestEventId)}</strong>
                </div>
              </div>
              {executiveEvents.length === 0 ? (
                <div className="empty-state executive-empty-state">No Revolut merchant events persisted yet.</div>
              ) : (
                <div className="merchant-events-list">
                  {executiveEvents.map((event) => (
                    <div key={event.eventId} className="merchant-event-card">
                      <div className="merchant-event-header">
                        <div className="merchant-event-amount">{formatExecutiveValue(event.amountDisplay, event.currency || '--')}</div>
                        <span className={`status-chip status-chip--${getFinanceStatusTone(event.paymentStatus || event.settlementStatus || event.eventType)}`}>
                          {String(event.paymentStatus || event.settlementStatus || event.eventType || 'pending').toUpperCase()}
                        </span>
                      </div>
                      <div className="merchant-event-ref">
                        {formatExecutiveValue(event.merchantOrderReference || event.merchantReference || event.orderId || event.eventId)}
                      </div>
                      <div className="merchant-event-customer">{formatExecutiveValue(event.customerEmail, 'Awaiting customer email')}</div>
                      <div className="merchant-event-grid">
                        <div>
                          <span>Settlement</span>
                          <strong>{formatExecutiveValue(event.settlementAmountDisplay)}</strong>
                        </div>
                        <div>
                          <span>Settled</span>
                          <strong>{formatExecutiveValue(event.settlementStatus)}</strong>
                        </div>
                        <div>
                          <span>Payment</span>
                          <strong>{formatExecutiveValue(event.paymentStatus)}</strong>
                        </div>
                        <div>
                          <span>Received</span>
                          <strong>{formatExecutiveTimestamp(event.receivedAt || event.createdAt)}</strong>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
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

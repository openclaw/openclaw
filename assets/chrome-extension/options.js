const DEFAULT_PORT = 18792

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://127.0.0.1:${port}/`
}

function relayHeaders(token) {
  const t = String(token || '').trim()
  if (!t) return {}
  return { 'x-openclaw-relay-token': t }
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(port, token) {
  const url = `http://127.0.0.1:${port}/json/version`
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Gateway token required. Save your gateway token to connect.')
    return
  }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 1200)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: relayHeaders(trimmedToken),
      signal: ctrl.signal,
    })
    if (res.status === 401) {
      setStatus('error', 'Gateway token rejected. Check token and save again.')
      return
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable and authenticated at http://127.0.0.1:${port}/`)
  } catch {
    setStatus(
      'error',
      `Relay not reachable/authenticated at http://127.0.0.1:${port}/. Start OpenClaw browser relay and verify token.`,
    )
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort', 'gatewayToken'])
  const port = clampPort(stored.relayPort)
  const token = String(stored.gatewayToken || '').trim()
  document.getElementById('port').value = String(port)
  document.getElementById('token').value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

async function save() {
  const portInput = document.getElementById('port')
  const tokenInput = document.getElementById('token')
  const port = clampPort(portInput.value)
  const token = String(tokenInput.value || '').trim()
  await chrome.storage.local.set({ relayPort: port, gatewayToken: token })
  portInput.value = String(port)
  tokenInput.value = token
  updateRelayUrl(port)
  await checkRelayReachable(port, token)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()

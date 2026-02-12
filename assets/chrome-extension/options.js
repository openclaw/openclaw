const DEFAULT_PORT = 18792

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function updateRelayUrl(host, port) {
  const el = document.getElementById('relay-url')
  if (!el) return
  el.textContent = `http://${host}:${port}/`
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(host, port) {
  const url = `http://${host}:${port}/`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 900)
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setStatus('ok', `Relay reachable at ${url}`)
  } catch {
    setStatus(
      'error',
      `Relay not reachable at ${url}. Start OpenClaw’s browser relay on this machine, then click the toolbar button again.`,
    )
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayPort', 'relayHost'])
  const port = clampPort(stored.relayPort)
  const host = (stored.relayHost || '').trim() || '127.0.0.1'
  document.getElementById('port').value = String(port)
  document.getElementById('host').value = host
  updateRelayUrl(host, port)
  await checkRelayReachable(host, port)
}

async function save() {
  const input = document.getElementById('port')
  const hostInput = document.getElementById('host')
  const port = clampPort(input.value)
  const host = (hostInput.value || '').trim() || '127.0.0.1'
  await chrome.storage.local.set({ relayPort: port, relayHost: host })
  input.value = String(port)
  hostInput.value = host
  updateRelayUrl(host, port)
  await checkRelayReachable(host, port)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()

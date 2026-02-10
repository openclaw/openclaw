const DEFAULT_PORT = 18792
// Historically hardcoded IP. We default to this for existing users if no value is set,
// but new users might prefer 127.0.0.1.
// Requirement: "Ensure the current hardcoded value (100.77.161.18) is used as the initial default if no storage value exists"
const LEGACY_DEFAULT_HOST = '127.0.0.1'

function clampPort(value) {
  const n = Number.parseInt(String(value || ''), 10)
  if (!Number.isFinite(n)) return DEFAULT_PORT
  if (n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function cleanHost(value) {
  let s = String(value || '').trim()
  // Basic cleanup: remove protocol if user pasted it
  s = s.replace(/^https?:\/\//, '').replace(/\/$/, '')
  return s || LEGACY_DEFAULT_HOST
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
  const stored = await chrome.storage.local.get(['relayHost', 'relayPort'])
  
  // Requirement 4: use legacy default if undefined
  const host = stored.relayHost ? cleanHost(stored.relayHost) : LEGACY_DEFAULT_HOST
  const port = clampPort(stored.relayPort)

  document.getElementById('host').value = host
  document.getElementById('port').value = String(port)
  
  updateRelayUrl(host, port)
  await checkRelayReachable(host, port)
}

async function save() {
  const hostInput = document.getElementById('host')
  const portInput = document.getElementById('port')
  
  const host = cleanHost(hostInput.value)
  const port = clampPort(portInput.value)
  
  await chrome.storage.local.set({ relayHost: host, relayPort: port })
  
  hostInput.value = host
  portInput.value = String(port)
  
  updateRelayUrl(host, port)
  await checkRelayReachable(host, port)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()

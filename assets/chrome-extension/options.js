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

async function deriveRelayToken(gatewayToken, port) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(gatewayToken), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC', key, enc.encode(`openclaw-extension-relay-v1:${port}`),
  )
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
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
  try {
    const relayToken = await deriveRelayToken(trimmedToken, port)
    // Delegate the fetch to the background service worker to bypass
    // CORS preflight on the custom x-openclaw-relay-token header.
    const res = await chrome.runtime.sendMessage({
      type: 'relayCheck',
      url,
      token: relayToken,
    })
    if (!res) throw new Error('No response from service worker')
    if (res.status === 401) {
      setStatus('error', 'Gateway token rejected. Check token and save again.')
      return
    }
    if (res.error) throw new Error(res.error)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    // Validate that this is a CDP relay /json/version payload, not gateway HTML.
    const contentType = String(res.contentType || '')
    const data = res.json
    if (!contentType.includes('application/json')) {
      setStatus(
        'error',
        'Wrong port: this is likely the gateway, not the relay. Use gateway port + 3 (for gateway 18789, relay is 18792).',
      )
      return
    }
    if (!data || typeof data !== 'object' || !('Browser' in data) || !('Protocol-Version' in data)) {
      setStatus(
        'error',
        'Wrong port: expected relay /json/version response. Use gateway port + 3 (for gateway 18789, relay is 18792).',
      )
      return
    }

    setStatus('ok', `Relay reachable and authenticated at http://127.0.0.1:${port}/`)
  } catch (err) {
    const message = String(err || '').toLowerCase()
    if (message.includes('json') || message.includes('syntax')) {
      setStatus(
        'error',
        'Wrong port: this is not a relay endpoint. Use gateway port + 3 (for gateway 18789, relay is 18792).',
      )
    } else {
      setStatus(
        'error',
        `Relay not reachable/authenticated at http://127.0.0.1:${port}/. Start OpenClaw browser relay and verify token.`,
      )
    }
  } catch (err) {
    const message = String(err || '').toLowerCase()
    if (message.includes('json') || message.includes('syntax')) {
      setStatus(
        'error',
        'Wrong port: this is not a relay endpoint. Use gateway port + 3 (for gateway 18789, relay is 18792).',
      )
    } else {
      setStatus(
        'error',
        `Relay not reachable/authenticated at http://127.0.0.1:${port}/. Start OpenClaw browser relay and verify token.`,
      )
    }
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

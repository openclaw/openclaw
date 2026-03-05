import { deriveRelayToken } from './background-utils.js'
import { classifyRelayCheckException, classifyRelayCheckResponse } from './options-validation.js'

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

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

function setLockUI(locked) {
  const toggle = document.getElementById('lock-toggle')
  const lockIcon = document.getElementById('lock-icon')
  const statusText = document.getElementById('lock-status-text')
  if (toggle) toggle.checked = !!locked
  if (lockIcon) lockIcon.style.display = locked ? 'inline' : 'none'
  if (statusText) {
    statusText.dataset.state = locked ? 'locked' : 'unlocked'
    statusText.textContent = locked
      ? '🔒 Locked — relay is pinned to the active tab'
      : '🔓 Unlocked — relay follows whichever tab is active'
  }
}

async function refreshLockStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'getLockStatus' })
    setLockUI(res?.lockTab ?? false)
  } catch {
    // background not ready yet
  }
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
    const result = classifyRelayCheckResponse(res, port)
    if (result.action === 'throw') throw new Error(result.error)
    setStatus(result.kind, result.message)
  } catch (err) {
    const result = classifyRelayCheckException(err, port)
    setStatus(result.kind, result.message)
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
  await refreshLockStatus()
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

// Lock toggle
document.getElementById('lock-toggle').addEventListener('change', async (e) => {
  const locked = e.target.checked
  const statusText = document.getElementById('lock-status-text')
  if (statusText) {
    statusText.dataset.state = ''
    statusText.textContent = 'Updating…'
  }
  const res = await chrome.runtime.sendMessage({ type: 'setLock', locked })
  if (res?.ok) {
    setLockUI(res.lockTab)
  } else {
    // Revert toggle on failure
    e.target.checked = !locked
    if (statusText) {
      statusText.dataset.state = 'unlocked'
      statusText.textContent = '⚠ Failed to update lock state. Is the relay running?'
    }
  }
})

void load()

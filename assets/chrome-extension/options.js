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

async function load() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const port = clampPort(stored.relayPort)
  document.getElementById('port').value = String(port)
  updateRelayUrl(port)
}

async function save() {
  const input = document.getElementById('port')
  const port = clampPort(input.value)
  await chrome.storage.local.set({ relayPort: port })
  input.value = String(port)
  updateRelayUrl(port)
  const status = document.getElementById('status')
  status.textContent = `Saved. Using http://127.0.0.1:${port}/`
  setTimeout(() => {
    status.textContent = ''
  }, 2000)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()

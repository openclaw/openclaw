// Reads real data from OpenClaw filesystem via the Vite plugin API
// Falls back gracefully when not available (prod build / no server)

const BASE = '/api/openclaw'

async function fetchJson(path: string) {
  try {
    const res = await fetch(`${BASE}${path}`)
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export async function getConfig() {
  return fetchJson('/config')
}

export async function getSkills(): Promise<Array<{ name: string; version?: string; description?: string }>> {
  const data = await fetchJson('/skills')
  return data ?? []
}

export async function getHeartbeat(): Promise<{ content: string | null }> {
  const data = await fetchJson('/heartbeat')
  return data ?? { content: null }
}

export async function getWorkspaceFiles() {
  return fetchJson('/workspace-files')
}

export async function getGatewayHealth(): Promise<{ online: boolean; port: number }> {
  const data = await fetchJson('/gateway-health')
  return data ?? { online: false, port: 18789 }
}

export async function getLogs(): Promise<{ lines: string[] }> {
  const data = await fetchJson('/logs')
  return data ?? { lines: [] }
}

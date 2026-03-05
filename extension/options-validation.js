const PORT_GUIDANCE = 'Use gateway port + 3 (for gateway 18789, relay is 18792).'

function hasCdpVersionShape(data) {
  return !!data && typeof data === 'object' && 'Browser' in data && 'Protocol-Version' in data
}

export function classifyRelayCheckResponse(res, port) {
  if (!res) {
    return { action: 'throw', error: 'No response from service worker' }
  }

  if (res.status === 401) {
    return { action: 'status', kind: 'error', message: 'Gateway token rejected. Check token and save again.' }
  }

  if (res.error) {
    return { action: 'throw', error: res.error }
  }

  if (!res.ok) {
    return { action: 'throw', error: `HTTP ${res.status}` }
  }

  const contentType = String(res.contentType || '')
  if (!contentType.includes('application/json')) {
    return {
      action: 'status',
      kind: 'error',
      message: `Wrong port: this is likely the gateway, not the relay. ${PORT_GUIDANCE}`,
    }
  }

  if (!hasCdpVersionShape(res.json)) {
    return {
      action: 'status',
      kind: 'error',
      message: `Wrong port: expected relay /json/version response. ${PORT_GUIDANCE}`,
    }
  }

  return { action: 'status', kind: 'ok', message: `Relay reachable and authenticated at http://127.0.0.1:${port}/` }
}

export function classifyRelayCheckException(err, port) {
  const message = String(err || '').toLowerCase()
  if (message.includes('json') || message.includes('syntax')) {
    return {
      kind: 'error',
      message: `Wrong port: this is not a relay endpoint. ${PORT_GUIDANCE}`,
    }
  }

  return {
    kind: 'error',
    message: `Relay not reachable/authenticated at http://127.0.0.1:${port}/. Start OpenClaw browser relay and verify token.`,
  }
}

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createGatewayWsRpcClient,
  type GatewayEventHandler,
} from '../api/gateway-ws'
import type { GatewayCallParams } from '../api/types'

type UseGatewayResult = {
  connected: boolean
  call: (method: string, params?: GatewayCallParams) => Promise<unknown>
  subscribe: (event: string, handler: GatewayEventHandler) => () => void
  reconnect: () => Promise<void>
}

export function useGateway(): UseGatewayResult {
  const client = useMemo(() => createGatewayWsRpcClient(), [])
  const [connected, setConnected] = useState(false)

  const reconnect = useCallback(async () => {
    client.disconnect()
    try {
      await client.connect()
      setConnected(true)
    } catch {
      setConnected(false)
      throw new Error('Gateway 重新連線失敗')
    }
  }, [client])

  const call = useCallback(
    async (method: string, params?: GatewayCallParams): Promise<unknown> => {
      if (!connected) {
        await reconnect()
      }
      return client.call(method, params)
    },
    [client, connected, reconnect],
  )

  const subscribe = useCallback(
    (event: string, handler: GatewayEventHandler): (() => void) => {
      return client.subscribe(event, handler)
    },
    [client],
  )

  useEffect(() => {
    let unmounted = false
    void (async () => {
      try {
        await client.connect()
        if (!unmounted) {
          setConnected(true)
        }
      } catch {
        if (!unmounted) {
          setConnected(false)
        }
      }
    })()

    return () => {
      unmounted = true
      client.disconnect()
    }
  }, [client])

  return {
    connected,
    call,
    subscribe,
    reconnect,
  }
}

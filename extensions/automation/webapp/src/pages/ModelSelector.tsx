import { useEffect, useMemo, useState } from 'react'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import { useAppStore } from '../stores/app-store'
import './ModelSelector.css'

type GroupedModels = Record<string, ReturnType<typeof useAppStore.getState>['models']>

function groupModels(models: ReturnType<typeof useAppStore.getState>['models']): GroupedModels {
  return models.reduce<GroupedModels>((acc, model) => {
    const group = model.provider ?? 'unknown'
    if (!acc[group]) {
      acc[group] = []
    }
    acc[group].push(model)
    return acc
  }, {})
}

export function ModelSelector() {
  const { models, refreshAll } = useAppStore((state) => ({
    models: state.models,
    refreshAll: state.refreshAll,
  }))

  const [busyModelId, setBusyModelId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (models.length === 0) {
      void refreshAll()
    }
  }, [models.length, refreshAll])

  const grouped = useMemo(() => groupModels(models), [models])
  const groupNames = useMemo(() => Object.keys(grouped).sort(), [grouped])

  async function switchModel(modelId: string): Promise<void> {
    setBusyModelId(modelId)
    setMessage('')
    const client = createGatewayWsRpcClient()
    try {
      await client.connect()
      await client.call('sessions.patch', { model: modelId })
      await refreshAll()
      setMessage(`模型已切換：${modelId}`)
    } catch {
      setMessage(`模型切換失敗：${modelId}`)
    } finally {
      client.disconnect()
      setBusyModelId(null)
    }
  }

  return (
    <section className="model-selector">
      <header className="model-card">
        <h1>模型切換</h1>
        <button
          type="button"
          className="model-btn-refresh"
          disabled={Boolean(busyModelId)}
          onClick={() => void refreshAll()}
        >
          刷新列表
        </button>
      </header>

      {message ? <p className="model-message">{message}</p> : null}

      {groupNames.length === 0 ? (
        <article className="model-card">
          <p>目前沒有模型資料。</p>
        </article>
      ) : (
        <div className="model-groups">
          {groupNames.map((group) => (
            <article key={group} className="model-card">
              <h2>{group}</h2>
              <ul className="model-list">
                {grouped[group].map((model) => (
                  <li key={model.id} className={model.active ? 'model-item model-item-active' : 'model-item'}>
                    <div className="model-item-main">
                      <strong>{model.displayName}</strong>
                      <span>ID：{model.id}</span>
                    </div>
                    <button
                      type="button"
                      disabled={busyModelId === model.id}
                      onClick={() => void switchModel(model.id)}
                    >
                      {model.active ? '目前使用中' : '切換'}
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

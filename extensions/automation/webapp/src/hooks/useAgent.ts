import { useEffect, useState } from 'react'
import type {
  ActiveTask,
  AgentInfo,
  AgentPhase,
  AttentionItem,
} from '../stores/app-store'
import { useAppStore } from '../stores/app-store'
import { useGateway } from './useGateway'

type UseAgentResult = {
  phase: AgentPhase
  activeTask: ActiveTask | null
  agents: AgentInfo[]
  attentionItems: AttentionItem[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function toPhase(value: unknown, fallback: AgentPhase): AgentPhase {
  if (value === 'idle' || value === 'running' || value === 'waiting' || value === 'error') {
    return value
  }
  return fallback
}

function toActiveTask(value: unknown): ActiveTask | null {
  if (!isObject(value)) {
    return null
  }
  return {
    id: asString(value.id, 'task-unknown'),
    title: asString(value.title, 'Untitled task'),
    progress: asNumber(value.progress, 0),
  }
}

function toAgents(value: unknown): AgentInfo[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      return {
        id: `agent-${index}`,
        name: `Agent ${index + 1}`,
        status: 'unknown',
      }
    }
    return {
      id: asString(item.id, `agent-${index}`),
      name: asString(item.name, `Agent ${index + 1}`),
      status: asString(item.status, 'unknown'),
      model: typeof item.model === 'string' ? item.model : undefined,
      turns: typeof item.turns === 'number' ? item.turns : undefined,
    }
  })
}

function toAttentionItems(value: unknown): AttentionItem[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map((item, index) => {
    if (!isObject(item)) {
      return {
        id: `attention-${index}`,
        title: `Attention ${index + 1}`,
        urgency: 'low',
      }
    }
    const urgency =
      item.urgency === 'high' || item.urgency === 'medium' || item.urgency === 'low'
        ? item.urgency
        : 'low'
    return {
      id: asString(item.id, `attention-${index}`),
      title: asString(item.title, `Attention ${index + 1}`),
      urgency,
    }
  })
}

export function useAgent(): UseAgentResult {
  const {
    phase: storePhase,
    activeTask: storeActiveTask,
    agents: storeAgents,
    attentionItems: storeAttentionItems,
    refreshAll,
  } = useAppStore((state) => ({
    phase: state.phase,
    activeTask: state.activeTask,
    agents: state.agents,
    attentionItems: state.attentionItems,
    refreshAll: state.refreshAll,
  }))

  const { subscribe } = useGateway()

  const [phase, setPhase] = useState<AgentPhase>(storePhase)
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(storeActiveTask)
  const [agents, setAgents] = useState<AgentInfo[]>(storeAgents)
  const [attentionItems, setAttentionItems] = useState<AttentionItem[]>(storeAttentionItems)

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  useEffect(() => {
    setPhase(storePhase)
    setActiveTask(storeActiveTask)
    setAgents(storeAgents)
    setAttentionItems(storeAttentionItems)
  }, [storePhase, storeActiveTask, storeAgents, storeAttentionItems])

  useEffect(() => {
    const unsubscribers = [
      subscribe('agent.state', (payload) => {
        if (!isObject(payload)) {
          return
        }
        setPhase((prev) => toPhase(payload.phase, prev))
        if ('activeTask' in payload) {
          setActiveTask(toActiveTask(payload.activeTask))
        }
        if ('agents' in payload) {
          setAgents(toAgents(payload.agents))
        }
        if ('attentionItems' in payload) {
          setAttentionItems(toAttentionItems(payload.attentionItems))
        }
      }),
      subscribe('agent.phase', (payload) => {
        setPhase((prev) => toPhase(payload, prev))
      }),
      subscribe('agent.active-task', (payload) => {
        setActiveTask(toActiveTask(payload))
      }),
      subscribe('agent.attention-items', (payload) => {
        setAttentionItems(toAttentionItems(payload))
      }),
    ]

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe())
    }
  }, [subscribe])

  return {
    phase,
    activeTask,
    agents,
    attentionItems,
  }
}

import { create } from 'zustand'
import { createGatewayWsRpcClient } from '../api/gateway-ws'
import type {
  ActiveTask,
  AgentInfo,
  AgentPhase,
  AttentionItem,
  CronJobInfo,
  ModelInfo,
} from '../api/types'
export type {
  ActiveTask,
  AgentInfo,
  AgentPhase,
  AttentionItem,
  CronJobInfo,
  ModelInfo,
} from '../api/types'

type UsageStats = {
  tokensToday: number
  tasksToday: number
}

export interface AppState {
  phase: AgentPhase
  activeTask: ActiveTask | null
  agents: AgentInfo[]
  cronJobs: CronJobInfo[]
  models: ModelInfo[]
  attentionItems: AttentionItem[]
  stats: UsageStats
  refreshAll: () => Promise<void>
  setPhase: (phase: AgentPhase) => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function toAgentInfo(value: unknown, index: number): AgentInfo {
  if (!isObject(value)) {
    return {
      id: `agent-${index}`,
      name: `Agent ${index + 1}`,
      status: 'unknown',
    }
  }

  return {
    id: asString(value.id, `agent-${index}`),
    name: asString(value.name, `Agent ${index + 1}`),
    status: asString(value.status, 'unknown'),
    model: asOptionalString(value.model),
    turns: asOptionalNumber(value.turns),
  }
}

function toCronJobInfo(value: unknown, index: number): CronJobInfo {
  if (!isObject(value)) {
    return {
      id: `cron-${index}`,
      name: `Cron ${index + 1}`,
      schedule: '* * * * *',
      enabled: false,
    }
  }

  return {
    id: asString(value.id, `cron-${index}`),
    name: asString(value.name, `Cron ${index + 1}`),
    schedule: asString(value.schedule, '* * * * *'),
    enabled: asBoolean(value.enabled, false),
  }
}

function toModelInfo(value: unknown, index: number): ModelInfo {
  if (!isObject(value)) {
    return {
      id: `model-${index}`,
      displayName: `Model ${index + 1}`,
    }
  }

  return {
    id: asString(value.id, `model-${index}`),
    provider: asOptionalString(value.provider),
    displayName: asString(value.displayName, asString(value.name, `Model ${index + 1}`)),
    active: asBoolean(value.active, false),
  }
}

function pickUsageStats(usagePayload: unknown): UsageStats {
  if (!isObject(usagePayload)) {
    return { tokensToday: 0, tasksToday: 0 }
  }
  return {
    tokensToday: asNumber(usagePayload.tokensToday, 0),
    tasksToday: asNumber(usagePayload.tasksToday, 0),
  }
}

export const useAppStore = create<AppState>((set) => ({
  phase: 'idle',
  activeTask: null,
  agents: [],
  cronJobs: [],
  models: [],
  attentionItems: [],
  stats: { tokensToday: 0, tasksToday: 0 },

  setPhase: (phase) => set({ phase }),

  refreshAll: async () => {
    set({ phase: 'running' })
    const client = createGatewayWsRpcClient()

    try {
      await client.connect()

      const [agentsRes, cronRes, modelsRes, usageRes] = await Promise.allSettled([
        client.call('agents.list'),
        client.call('cron.list'),
        client.call('models.list'),
        client.call('usage.status'),
      ])

      const agents =
        agentsRes.status === 'fulfilled'
          ? asArray(agentsRes.value).map((item, index) => toAgentInfo(item, index))
          : []

      const cronJobs =
        cronRes.status === 'fulfilled'
          ? asArray(cronRes.value).map((item, index) => toCronJobInfo(item, index))
          : []

      const models =
        modelsRes.status === 'fulfilled'
          ? asArray(modelsRes.value).map((item, index) => toModelInfo(item, index))
          : []

      const stats =
        usageRes.status === 'fulfilled'
          ? pickUsageStats(usageRes.value)
          : { tokensToday: 0, tasksToday: 0 }

      set({
        phase: 'idle',
        agents,
        cronJobs,
        models,
        stats,
      })
    } catch {
      set({ phase: 'error' })
    } finally {
      client.disconnect()
    }
  },
}))

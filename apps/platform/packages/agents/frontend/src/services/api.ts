import axios from 'axios'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  headers: {
    'Content-Type': 'application/json',
  },
})

// Types
export interface Agent {
  id: number
  name: string
  slug: string
  agent_type: string
  status: 'idle' | 'running' | 'error' | 'disabled'
  is_enabled: boolean
  is_running: boolean
  schedule?: string
  last_run_at?: string
  total_runs: number
  successful_runs: number
  failed_runs: number
  capabilities: string[]
}

export interface Task {
  id: number
  name: string
  task_type: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  priority: 'low' | 'medium' | 'high' | 'critical'
  created_at: string
  started_at?: string
  completed_at?: string
  execution_time?: number
}

export interface Integration {
  id: number
  name: string
  slug: string
  service_type: string
  status: 'connected' | 'disconnected' | 'error'
  is_enabled: boolean
  last_health_check?: string
  error_message?: string
}

export interface Notification {
  id: number
  title: string
  message: string
  type: string
  priority: string
  is_read: boolean
  created_at: string
}

export interface SystemStatus {
  status: 'running' | 'stopped'
  timestamp: string
  agents: Record<string, number>
  pending_tasks: number
  version: string
}

// API functions
export const api = {
  // System
  async getStatus(): Promise<SystemStatus> {
    const { data } = await apiClient.get('/status')
    return data
  },

  async getHealth() {
    const { data } = await apiClient.get('/health')
    return data
  },

  async getObservabilitySummary(): Promise<{
    timestamp: string
    orchestrator_running: boolean
    agents: Array<{
      name: string
      slug: string
      status: string
      is_running: boolean
      total_runs: number
      successful_runs: number
      failed_runs: number
      last_run_at: string | null
      last_error: string | null
    }>
    tasks: { pending: number; running: number; failed_last_24h: number }
  }> {
    const { data } = await apiClient.get('/api/observability/summary')
    return data
  },

  async getMetrics(): Promise<{
    agents_total: number
    agents_enabled: number
    task_runs_total: number
    task_runs_successful: number
    task_runs_failed: number
    tasks_pending: number
    tasks_running: number
    timestamp: string
  }> {
    const { data } = await apiClient.get('/api/metrics')
    return data
  },

  // Agents
  async getAgents(): Promise<{ agents: Agent[]; count: number }> {
    const { data } = await apiClient.get('/api/agents')
    return data
  },

  async getAgent(slug: string): Promise<Agent> {
    const { data } = await apiClient.get(`/api/agents/${slug}`)
    return data
  },

  async runAgent(slug: string) {
    const { data } = await apiClient.post(`/api/agents/${slug}/run`)
    return data
  },

  async updateAgent(slug: string, updates: Partial<Agent>) {
    const { data } = await apiClient.patch(`/api/agents/${slug}`, updates)
    return data
  },

  // Tasks
  async getTasks(params?: { agent_slug?: string; status?: string; limit?: number }): Promise<{ tasks: Task[]; count: number }> {
    const { data } = await apiClient.get('/api/tasks', { params })
    return data
  },

  async createTask(task: {
    agent_slug: string
    name: string
    task_type: string
    input_data?: Record<string, any>
    priority?: string
  }) {
    const { data } = await apiClient.post('/api/tasks', task)
    return data
  },

  // Integrations
  async getIntegrations(): Promise<{ integrations: Integration[] }> {
    const { data } = await apiClient.get('/api/integrations')
    return data
  },

  async checkIntegrationHealth(slug: string) {
    const { data } = await apiClient.get(`/api/integrations/${slug}/health`)
    return data
  },

  // AI Providers
  async getAIProviders(): Promise<{
    providers: Array<{
      name: string
      configured: boolean
      model: string | null
      in_preference_order: boolean
    }>
    preference_order: string[]
    gateway_url: string
  }> {
    const { data } = await apiClient.get('/api/ai/providers')
    return data
  },

  async checkAIHealth(): Promise<{
    status: string
    configured_providers: string[]
    connected_count: number
    provider_details: Record<string, { status: string; model?: string; error?: string }>
  }> {
    const { data } = await apiClient.get('/api/ai/health')
    return data
  },

  // Logs & Activity
  async getLogs(params?: { agent_slug?: string; level?: string; limit?: number }) {
    const { data } = await apiClient.get('/api/logs', { params })
    return data
  },

  async getActivity(limit = 50) {
    const { data } = await apiClient.get('/api/activity', { params: { limit } })
    return data
  },

  // Notifications
  async getNotifications(unreadOnly = false): Promise<{ notifications: Notification[] }> {
    const { data } = await apiClient.get('/api/notifications', {
      params: { unread_only: unreadOnly },
    })
    return data
  },

  async markNotificationRead(id: number) {
    const { data } = await apiClient.patch(`/api/notifications/${id}/read`)
    return data
  },
}

export default api

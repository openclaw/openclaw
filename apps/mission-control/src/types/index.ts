export type TaskStatus = 'recurring' | 'backlog' | 'in_progress' | 'review' | 'done'
export type AgentStatus = 'idle' | 'researching' | 'coding' | 'reviewing' | 'meeting' | 'offline'
export type Priority = 'low' | 'medium' | 'high' | 'critical'

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  priority: Priority
  agentId?: string
  projectId?: string
  tags: string[]
  createdAt: string
  updatedAt: string
  dueDate?: string
  completedAt?: string
  streak?: number
  isRecurring?: boolean
  recurringCron?: string
}

export interface Agent {
  id: string
  name: string
  emoji: string
  model: string
  role: string
  status: AgentStatus
  description: string
  skills: string[]
  tasksCompleted: number
  tokensUsed: number
  costToday: number
  lastActiveAt: string
  color: string
}

export interface Project {
  id: string
  name: string
  description: string
  emoji: string
  color: string
  progress: number
  agentIds: string[]
  taskIds: string[]
  docIds: string[]
  memoryIds: string[]
  createdAt: string
  updatedAt: string
  status: 'active' | 'paused' | 'done' | 'archived'
  tags: string[]
}

export interface Memory {
  id: string
  content: string
  type: 'short' | 'long'
  source: 'agent' | 'user' | 'system'
  agentId?: string
  projectId?: string
  tags: string[]
  createdAt: string
  date: string
}

export interface Doc {
  id: string
  title: string
  content: string
  type: 'plan' | 'draft' | 'report' | 'guide' | 'note'
  agentId?: string
  projectId?: string
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface ScheduledJob {
  id: string
  name: string
  cron: string
  description: string
  agentId?: string
  nextRun?: string
  lastRun?: string
  enabled: boolean
}

export interface Skill {
  name: string
  version?: string
  description?: string
  enabled: boolean
}

export interface Contact {
  id: string
  name: string
  email?: string
  company?: string
  role?: string
  tags: string[]
  notes?: string
  lastContactedAt?: string
  source?: string
}

export interface Integration {
  id: string
  name: string
  type: 'mcp' | 'api' | 'webhook'
  status: 'connected' | 'disconnected' | 'error'
  description: string
  icon?: string
  lastUsedAt?: string
}

export interface CostRecord {
  date: string
  agentId: string
  model: string
  tokens: number
  cost: number
}

export interface DailyStandup {
  date: string
  yesterday: string[]
  today: string[]
  blockers: string[]
  generatedAt: string
}

import type { Task, Agent, Project, Memory, Doc, Contact } from '../types'

export const SEED_AGENTS: Agent[] = [
  {
    id: 'luciel',
    name: 'Luciel',
    emoji: '🤖',
    model: 'openai/gpt-4o-mini',
    role: 'Primary Agent',
    status: 'idle',
    description: 'Jason\'s main agent. Handles Telegram, morning briefings, order checks, and general tasks.',
    skills: ['oralabs-cs', 'youtube-shorts', 'marketing', 'email-manager'],
    tasksCompleted: 47,
    tokensUsed: 284000,
    costToday: 0.12,
    lastActiveAt: new Date().toISOString(),
    color: '#3b82f6',
  },
  {
    id: 'forge',
    name: 'Forge',
    emoji: '⚒️',
    model: 'claude-opus-4-6',
    role: 'Build Agent',
    status: 'coding',
    description: 'Handles code generation, refactoring, and software engineering tasks.',
    skills: ['github', 'playwright'],
    tasksCompleted: 23,
    tokensUsed: 180000,
    costToday: 2.40,
    lastActiveAt: new Date(Date.now() - 5 * 60000).toISOString(),
    color: '#f59e0b',
  },
  {
    id: 'scout',
    name: 'Scout',
    emoji: '🔭',
    model: 'claude-sonnet-4-6',
    role: 'Research Agent',
    status: 'researching',
    description: 'Web research, news aggregation, competitive intelligence.',
    skills: ['news-aggregator', 'firecrawl'],
    tasksCompleted: 31,
    tokensUsed: 96000,
    costToday: 0.55,
    lastActiveAt: new Date(Date.now() - 2 * 60000).toISOString(),
    color: '#10b981',
  },
]

export const SEED_TASKS: Task[] = [
  {
    id: 't1', title: 'Morning Market Briefing', description: 'Stock market, crypto, Ora Labs news, calendar reminders',
    status: 'recurring', priority: 'high', agentId: 'luciel', tags: ['briefing', 'telegram'],
    createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-29T07:00:00Z',
    isRecurring: true, recurringCron: '0 7 * * 1-5', streak: 18,
  },
  {
    id: 't2', title: 'Ora Labs Order Check', description: 'Check for new orders and customer inquiries every 4h',
    status: 'recurring', priority: 'high', agentId: 'luciel', tags: ['oralabs', 'orders'],
    createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-29T09:00:00Z',
    isRecurring: true, recurringCron: '0 9,13,17,21 * * *', streak: 12,
  },
  {
    id: 't3', title: 'System Health Check', description: 'Gateway process, disk, RAM, miner status',
    status: 'recurring', priority: 'medium', agentId: 'luciel', tags: ['system', 'monitoring'],
    createdAt: '2026-03-01T00:00:00Z', updatedAt: '2026-03-29T08:30:00Z',
    isRecurring: true, recurringCron: '*/30 * * * *', streak: 24,
  },
  {
    id: 't4', title: 'Set up WooCommerce API keys for Ora Labs',
    status: 'backlog', priority: 'high', agentId: 'luciel', projectId: 'oralabs', tags: ['oralabs', 'api'],
    createdAt: '2026-03-25T00:00:00Z', updatedAt: '2026-03-25T00:00:00Z',
  },
  {
    id: 't5', title: 'Build Mission Control Dashboard',
    status: 'in_progress', priority: 'critical', agentId: 'forge', tags: ['dev', 'ui'],
    createdAt: '2026-03-29T00:00:00Z', updatedAt: '2026-03-29T10:00:00Z',
  },
  {
    id: 't6', title: 'Configure static IP on server (10.0.0.59)',
    status: 'backlog', priority: 'medium', tags: ['server', 'network'],
    createdAt: '2026-03-27T00:00:00Z', updatedAt: '2026-03-27T00:00:00Z',
  },
  {
    id: 't7', title: 'Set up auto-login (netplwiz)',
    status: 'backlog', priority: 'medium', tags: ['server', 'windows'],
    createdAt: '2026-03-27T00:00:00Z', updatedAt: '2026-03-27T00:00:00Z',
  },
  {
    id: 't8', title: 'YouTube Shorts for Ora Labs — March batch',
    status: 'backlog', priority: 'medium', agentId: 'luciel', projectId: 'oralabs', tags: ['content', 'youtube'],
    createdAt: '2026-03-20T00:00:00Z', updatedAt: '2026-03-20T00:00:00Z',
  },
  {
    id: 't9', title: 'Review parallel worker PRs (admin-scripts, gateway, etc.)',
    status: 'review', priority: 'high', tags: ['dev', 'pr'],
    createdAt: '2026-03-29T00:00:00Z', updatedAt: '2026-03-29T10:00:00Z',
  },
  {
    id: 't10', title: 'Connect Telegram bot @Lucielthebot',
    status: 'done', priority: 'critical', agentId: 'luciel', tags: ['telegram', 'setup'],
    createdAt: '2026-03-27T00:00:00Z', updatedAt: '2026-03-29T06:00:00Z',
    completedAt: '2026-03-29T06:00:00Z',
  },
  {
    id: 't11', title: 'Install OpenClaw on Acer server', status: 'done', priority: 'critical', tags: ['setup'],
    createdAt: '2026-03-26T00:00:00Z', updatedAt: '2026-03-27T00:00:00Z', completedAt: '2026-03-27T00:00:00Z',
  },
  {
    id: 't12', title: 'Research Solana ecosystem — weekly report',
    status: 'in_progress', priority: 'medium', agentId: 'scout', tags: ['crypto', 'research'],
    createdAt: '2026-03-29T08:00:00Z', updatedAt: '2026-03-29T10:00:00Z',
  },
]

export const SEED_PROJECTS: Project[] = [
  {
    id: 'oralabs',
    name: 'Ora Labs',
    description: 'Research peptide e-commerce business. WooCommerce store, customer service automation, marketing.',
    emoji: '🧬',
    color: '#10b981',
    progress: 35,
    agentIds: ['luciel'],
    taskIds: ['t4', 't8'],
    docIds: [],
    memoryIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-29T00:00:00Z',
    status: 'active',
    tags: ['ecommerce', 'peptides', 'woocommerce'],
  },
  {
    id: 'server-setup',
    name: 'Agent Server Setup',
    description: 'Configure the Acer Aspire as a 24/7 OpenClaw server. Admin scripts, gateway management, monitoring.',
    emoji: '🖥️',
    color: '#3b82f6',
    progress: 75,
    agentIds: ['luciel', 'forge'],
    taskIds: ['t5', 't6', 't7', 't9', 't10', 't11'],
    docIds: [],
    memoryIds: [],
    createdAt: '2026-03-26T00:00:00Z',
    updatedAt: '2026-03-29T00:00:00Z',
    status: 'active',
    tags: ['server', 'windows', 'openclaw'],
  },
  {
    id: 'mission-control',
    name: 'Mission Control',
    description: 'Interactive AI operating system dashboard for managing all agents, tasks, projects, and memories.',
    emoji: '🚀',
    color: '#8b5cf6',
    progress: 20,
    agentIds: ['forge'],
    taskIds: ['t5'],
    docIds: [],
    memoryIds: [],
    createdAt: '2026-03-29T00:00:00Z',
    updatedAt: '2026-03-29T00:00:00Z',
    status: 'active',
    tags: ['dev', 'react', 'dashboard'],
  },
]

export const SEED_MEMORIES: Memory[] = [
  {
    id: 'm1', content: 'OpenClaw gateway runs from Claude Store path: C:\\Users\\jason\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js',
    type: 'long', source: 'system', tags: ['openclaw', 'gateway', 'windows'],
    createdAt: '2026-03-27T00:00:00Z', date: '2026-03-27',
  },
  {
    id: 'm2', content: 'Telegram bot @lucielthebot token: 8144974545:AAGDzuLiCiOWfKILEA6Zp8RNtDg7uz0Sfps — Jason\'s Telegram ID: 5678617611',
    type: 'long', source: 'user', tags: ['telegram', 'bot', 'credentials'],
    createdAt: '2026-03-28T00:00:00Z', date: '2026-03-28',
  },
  {
    id: 'm3', content: 'OpenAI key sk-proj-Psndu1bUxh... has $30 credit balance and is active (last used Mar 28 2026). Model: gpt-4o-mini for cost savings.',
    type: 'long', source: 'user', tags: ['openai', 'api', 'cost'],
    createdAt: '2026-03-28T00:00:00Z', date: '2026-03-28',
  },
  {
    id: 'm4', content: 'Acer Aspire TC-1760: i5-12400, 12GB RAM (only 1.7GB free with miners running). Bitcoin miners are Antminer units consuming most RAM.',
    type: 'long', source: 'system', tags: ['server', 'hardware', 'ram'],
    createdAt: '2026-03-26T00:00:00Z', date: '2026-03-26',
  },
  {
    id: 'm5', content: 'Morning briefing routine confirmed working on Mar 29. Luciel sent market summary via Telegram at 7:03 AM ET.',
    type: 'short', source: 'agent', agentId: 'luciel', tags: ['briefing', 'telegram', 'working'],
    createdAt: '2026-03-29T12:03:00Z', date: '2026-03-29',
  },
  {
    id: 'm6', content: 'Ora Labs WooCommerce API keys not yet configured. Customer service skill will be limited until keys are added.',
    type: 'short', source: 'agent', agentId: 'luciel', projectId: 'oralabs', tags: ['oralabs', 'woocommerce', 'blocker'],
    createdAt: '2026-03-29T09:00:00Z', date: '2026-03-29',
  },
]

export const SEED_DOCS: Doc[] = [
  {
    id: 'd1', title: 'Agent Server Setup Guide',
    content: '# Agent Server Setup Guide\n\nThis guide covers everything needed to run OpenClaw as a 24/7 agent server on Windows 11.\n\n## Hardware\n- Acer Aspire TC-1760\n- Intel Core i5-12400\n- 12GB RAM\n\n## Software\n- OpenClaw v2026.3.24\n- Node.js v24.0.2\n- Windows 11 Home\n\n## Gateway\nRuns on port 18789, bound to loopback.\nAuth token required for all API calls.',
    type: 'guide', tags: ['server', 'setup', 'openclaw'],
    createdAt: '2026-03-27T00:00:00Z', updatedAt: '2026-03-29T00:00:00Z',
  },
  {
    id: 'd2', title: 'Mission Control Architecture Plan',
    content: '# Mission Control Architecture\n\n## Tech Stack\n- React 18 + TypeScript\n- Vite 6\n- Tailwind CSS\n- Zustand (state)\n- React Query (data fetching)\n- React Router\n\n## Data Sources\n- OpenClaw filesystem API (Vite plugin)\n- OpenClaw gateway REST API (port 18789)\n- localStorage (user data)\n\n## Screens\nTasks, Calendar, Projects, Memory, Docs, Team, Office, Skills, System, Integrations',
    type: 'plan', tags: ['dev', 'architecture', 'mission-control'],
    createdAt: '2026-03-29T00:00:00Z', updatedAt: '2026-03-29T00:00:00Z',
  },
]

export const SEED_CONTACTS: Contact[] = [
  {
    id: 'c1', name: 'Jason Figueroa', email: 'jasonfg06@gmail.com', company: 'Ora Labs / EJ Corp LLC',
    role: 'Founder', tags: ['owner', 'user'], notes: 'The human. ET timezone. Into crypto, peptides, AI.',
    source: 'user',
  },
]

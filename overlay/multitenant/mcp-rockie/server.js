#!/usr/bin/env node
/**
 * mcp-rockie — MCP server giving claude/codex access to the tenant's
 * Rockie artifact ops (labs, sources, notes, search, jobs, artifacts).
 *
 * Tools mirror the JSON schemas in
 * platform-context/api/agent_tools/schemas.py. Each tool is an HTTP
 * call into platform-context's REST API. We auth with the env vars
 * the runtime image already has:
 *   ROCKIELAB_API_BASE          (default https://api.rockielab.com)
 *   ROCKIELAB_API_PASSWORD      (mirrors OPEN_NOTEBOOK_PASSWORD)
 *   ROCKIELAB_TENANT_DEV_TOKEN  (per-tenant)
 *
 * Registered into ~/.claude/mcp.json + ~/.codex/mcp.json at image
 * build time (see Dockerfile.multitenant).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE =
  process.env.ROCKIELAB_API_BASE || 'https://api.rockielab.com'
const API_PASSWORD =
  process.env.ROCKIELAB_API_PASSWORD || process.env.OPEN_NOTEBOOK_PASSWORD || ''
const TENANT_TOKEN = process.env.ROCKIELAB_TENANT_DEV_TOKEN || ''

const TOOLS = [
  {
    name: 'list_labs',
    description:
      "List the labs (notebooks) the current tenant owns. Use when the user asks about their workspace or you need to find a lab id by name.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_lab',
    description:
      "Read one lab's metadata + linked sources/notes/chat-session ids. Use after list_labs to drill in, or when the user names a specific lab.",
    inputSchema: {
      type: 'object',
      properties: { lab_id: { type: 'string' } },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sources_for_lab',
    description:
      'List all sources attached to a lab. Returns id + title + a short content preview.',
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_source',
    description:
      "Read one source's full content. Heavyweight; only use when the preview from list_sources_for_lab isn't enough.",
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string' } },
      required: ['source_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_notes_for_lab',
    description:
      'List notes attached to a lab. Returns id + title + content preview. Notes are agent-generated or human-written text artifacts.',
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_note',
    description:
      'Create a new note in a lab. Use to persist a useful summary, hypothesis, or finding so the user can refer back to it later.',
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        content: { type: 'string', minLength: 1 },
        note_type: {
          type: 'string',
          enum: ['text', 'structured', 'human'],
          default: 'text',
        },
      },
      required: ['lab_id', 'title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_experiment',
    description:
      "Submit a GPU job (DFT, MD, training, embedding, etc.) against the platform's compute pool. Returns a job id and an estimated cost in cents.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        workload: {
          type: 'string',
          enum: ['dft', 'md', 'training', 'embedding', 'other'],
        },
        description: { type: 'string', minLength: 5 },
        gpu_type: { type: 'string', default: 'a100' },
        gpu_count: { type: 'integer', minimum: 1, maximum: 16, default: 1 },
        estimated_minutes: {
          type: 'integer',
          minimum: 1,
          maximum: 1440,
          default: 60,
        },
      },
      required: ['lab_id', 'workload', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_job_status',
    description:
      'Read the current state of a previously-submitted job. Use to check progress or confirm completion.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description:
      "Search the tenant's corpus (sources + notes + insights) by vector + text match. Use for grounding answers in the tenant's data, not for general web research.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        lab_id: { type: 'string' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_artifacts',
    description:
      'List artifacts (audio, slides, charts, reports, sim_inputs, documents) attached to a lab.',
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['audio', 'slides', 'chart', 'report', 'document', 'sim_input'],
        },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
]

function authHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (API_PASSWORD) h['Authorization'] = `Bearer ${API_PASSWORD}`
  if (TENANT_TOKEN) h['X-Tenant-Token'] = TENANT_TOKEN
  return h
}

async function api(method, path, body) {
  const url = `${API_BASE}${path}`
  const init = { method, headers: authHeaders() }
  if (body !== undefined) init.body = JSON.stringify(body)
  const r = await fetch(url, init)
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${text.slice(0, 240)}`)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const HANDLERS = {
  async list_labs({ limit = 50 }) {
    return api('GET', `/api/notebooks?limit=${limit}&order_by=updated+desc`)
  },
  async get_lab({ lab_id }) {
    return api('GET', `/api/notebooks/${encodeURIComponent(lab_id)}`)
  },
  async list_sources_for_lab({ lab_id, limit = 25 }) {
    return api(
      'GET',
      `/api/sources?notebook_id=${encodeURIComponent(lab_id)}&limit=${limit}&sort_by=updated&sort_order=desc`,
    )
  },
  async get_source({ source_id }) {
    return api('GET', `/api/sources/${encodeURIComponent(source_id)}`)
  },
  async list_notes_for_lab({ lab_id, limit = 25 }) {
    const all = await api(
      'GET',
      `/api/notes?notebook_id=${encodeURIComponent(lab_id)}`,
    )
    return Array.isArray(all) ? all.slice(0, limit) : all
  },
  async create_note({ lab_id, title, content, note_type = 'text' }) {
    return api('POST', `/api/notes`, {
      notebook_id: lab_id,
      title,
      content,
      note_type,
    })
  },
  async submit_experiment(args) {
    return api('POST', `/api/jobs/submit`, args)
  },
  async get_job_status({ job_id }) {
    return api('GET', `/api/jobs/${encodeURIComponent(job_id)}`)
  },
  async search({ query, lab_id, k = 10 }) {
    const body = { query, k }
    if (lab_id) body.notebook_id = lab_id
    return api('POST', `/api/search`, body)
  },
  async list_artifacts({ lab_id, kind, limit = 25 }) {
    const qs = new URLSearchParams({ notebook_id: lab_id, limit: String(limit) })
    if (kind) qs.set('kind', kind)
    return api('GET', `/api/artifacts?${qs.toString()}`)
  },
}

const server = new Server(
  { name: 'mcp-rockie', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  const handler = HANDLERS[name]
  if (!handler) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
      isError: true,
    }
  }
  try {
    const result = await handler(args)
    return {
      content: [
        {
          type: 'text',
          text:
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2).slice(0, 16000),
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err?.message || String(err) }),
        },
      ],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)

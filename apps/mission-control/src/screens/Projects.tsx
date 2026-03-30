import { useStore } from '../store'
import type { Project } from '../types'
import { FolderOpen, CheckSquare, Users, FileText, Plus } from 'lucide-react'
import clsx from 'clsx'

const STATUS_COLORS = {
  active: 'bg-emerald-900/40 text-emerald-400',
  paused: 'bg-amber-900/40 text-amber-400',
  done: 'bg-blue-900/40 text-blue-400',
  archived: 'bg-neutral-800 text-neutral-500',
}

function ProjectCard({ project }: { project: Project }) {
  const { tasks, agents, docs } = useStore()
  const projectTasks = tasks.filter(t => t.projectId === project.id)
  const projectAgents = agents.filter(a => project.agentIds.includes(a.id))
  const done = projectTasks.filter(t => t.status === 'done').length
  const total = projectTasks.length

  return (
    <div className="card hover:border-white/[0.12] transition-all">
      {/* Header */}
      <div className="flex items-start gap-3 mb-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0"
          style={{ background: project.color + '22', border: `1px solid ${project.color}44` }}>
          {project.emoji}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-semibold text-white">{project.name}</span>
            <span className={clsx('badge text-[10px]', STATUS_COLORS[project.status])}>{project.status}</span>
          </div>
          <p className="text-xs text-neutral-500 line-clamp-2">{project.description}</p>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-3">
        <div className="flex items-center justify-between text-xs mb-1">
          <span className="text-neutral-500">Progress</span>
          <span className="text-white font-semibold">{project.progress}%</span>
        </div>
        <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${project.progress}%`, background: project.color }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="text-center bg-white/[0.03] rounded-lg py-1.5">
          <div className="text-sm font-semibold text-white">{total}</div>
          <div className="text-[10px] text-neutral-500 flex items-center justify-center gap-0.5"><CheckSquare size={8} />Tasks</div>
        </div>
        <div className="text-center bg-white/[0.03] rounded-lg py-1.5">
          <div className="text-sm font-semibold text-white">{projectAgents.length}</div>
          <div className="text-[10px] text-neutral-500 flex items-center justify-center gap-0.5"><Users size={8} />Agents</div>
        </div>
        <div className="text-center bg-white/[0.03] rounded-lg py-1.5">
          <div className="text-sm font-semibold text-white">{done}</div>
          <div className="text-[10px] text-neutral-500">Done</div>
        </div>
      </div>

      {/* Agents */}
      {projectAgents.length > 0 && (
        <div className="flex items-center gap-1.5 mb-2">
          {projectAgents.map(a => (
            <div key={a.id} title={a.name}
              className="w-6 h-6 rounded-full flex items-center justify-center text-xs border border-white/[0.1]"
              style={{ background: a.color + '33' }}>
              {a.emoji}
            </div>
          ))}
          <span className="text-[10px] text-neutral-600">{projectAgents.map(a => a.name).join(', ')}</span>
        </div>
      )}

      {/* Tags */}
      <div className="flex gap-1 flex-wrap">
        {project.tags.map(t => (
          <span key={t} className="badge bg-white/[0.04] text-neutral-500 text-[10px]">{t}</span>
        ))}
      </div>
    </div>
  )
}

export function Projects() {
  const { projects } = useStore()
  const active = projects.filter(p => p.status === 'active')
  const other = projects.filter(p => p.status !== 'active')

  return (
    <div className="p-5">
      <div className="flex items-center justify-between mb-5">
        <p className="text-sm text-neutral-400">{projects.length} projects · {active.length} active</p>
        <button className="btn-primary flex items-center gap-1.5">
          <Plus size={13} />
          New Project
        </button>
      </div>

      {active.length > 0 && (
        <>
          <div className="text-xs font-semibold text-neutral-600 uppercase tracking-widest mb-3">Active</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-6">
            {active.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        </>
      )}

      {other.length > 0 && (
        <>
          <div className="text-xs font-semibold text-neutral-600 uppercase tracking-widest mb-3">Other</div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {other.map(p => <ProjectCard key={p.id} project={p} />)}
          </div>
        </>
      )}
    </div>
  )
}

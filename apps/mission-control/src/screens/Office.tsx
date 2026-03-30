import { useStore } from '../store'
import type { AgentStatus } from '../types'
import clsx from 'clsx'

const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  researching: 'Researching',
  coding: 'Coding',
  reviewing: 'Reviewing',
  meeting: 'In Meeting',
  offline: 'Offline',
}

const STATUS_ANIMATIONS: Record<AgentStatus, string> = {
  idle: '',
  researching: 'animate-bounce',
  coding: 'animate-pulse',
  reviewing: '',
  meeting: 'animate-pulse',
  offline: 'opacity-30',
}

const STATUS_BG: Record<AgentStatus, string> = {
  idle: 'bg-neutral-800',
  researching: 'bg-cyan-900/50 border-cyan-700/50',
  coding: 'bg-blue-900/50 border-blue-700/50',
  reviewing: 'bg-amber-900/50 border-amber-700/50',
  meeting: 'bg-violet-900/50 border-violet-700/50',
  offline: 'bg-neutral-900',
}

// Pixel-art style desk positions
const DESKS = [
  { x: 10, y: 20 },
  { x: 40, y: 20 },
  { x: 70, y: 20 },
  { x: 10, y: 55 },
  { x: 40, y: 55 },
  { x: 70, y: 55 },
]

function PixelAgent({ agent, x, y }: { agent: any; x: number; y: number }) {
  return (
    <div
      className="absolute flex flex-col items-center gap-1 cursor-pointer group"
      style={{ left: `${x}%`, top: `${y}%`, transform: 'translate(-50%, -50%)' }}
    >
      {/* Desk */}
      <div className={clsx(
        'w-20 h-14 rounded-lg border flex flex-col items-center justify-center gap-1 transition-all',
        'hover:scale-110 hover:z-10 relative',
        STATUS_BG[agent.status]
      )}>
        {/* Screen glow for active agents */}
        {agent.status === 'coding' && (
          <div className="absolute inset-0 rounded-lg bg-blue-500/10 animate-pulse" />
        )}
        {/* Agent avatar */}
        <div className={clsx('text-2xl', STATUS_ANIMATIONS[agent.status])}>
          {agent.emoji}
        </div>
        {/* Status indicator */}
        <div className={clsx('text-[9px] font-medium', {
          'text-neutral-400': agent.status === 'idle',
          'text-cyan-400': agent.status === 'researching',
          'text-blue-400': agent.status === 'coding',
          'text-amber-400': agent.status === 'reviewing',
          'text-violet-400': agent.status === 'meeting',
          'text-neutral-700': agent.status === 'offline',
        })}>
          {STATUS_LABELS[agent.status]}
        </div>
      </div>
      {/* Name tag */}
      <div className="text-[10px] text-neutral-400 group-hover:text-white transition-colors">{agent.name}</div>

      {/* Tooltip on hover */}
      <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover:block z-20 pointer-events-none">
        <div className="bg-[#1a1a1a] border border-white/[0.1] rounded-lg p-2 text-xs text-white whitespace-nowrap shadow-xl">
          <div className="font-semibold">{agent.name}</div>
          <div className="text-neutral-400">{agent.model}</div>
          <div className="text-neutral-400">{agent.tasksCompleted} tasks done</div>
          <div className="text-neutral-400">${agent.costToday.toFixed(2)} today</div>
        </div>
      </div>
    </div>
  )
}

export function Office() {
  const { agents } = useStore()
  const active = agents.filter(a => a.status !== 'offline')

  return (
    <div className="p-5 h-full flex flex-col">
      <p className="text-sm text-neutral-400 mb-4">
        Live view of all agents and their current state
      </p>

      {/* Legend */}
      <div className="flex gap-3 mb-4 flex-wrap">
        {Object.entries(STATUS_LABELS).filter(([k]) => k !== 'offline').map(([status, label]) => (
          <div key={status} className={clsx('flex items-center gap-1.5 text-xs', {
            'text-neutral-400': status === 'idle',
            'text-cyan-400': status === 'researching',
            'text-blue-400': status === 'coding',
            'text-amber-400': status === 'reviewing',
            'text-violet-400': status === 'meeting',
          })}>
            <div className={clsx('w-2 h-2 rounded-full', {
              'bg-neutral-500': status === 'idle',
              'bg-cyan-400 animate-pulse': status === 'researching',
              'bg-blue-400 animate-pulse': status === 'coding',
              'bg-amber-400': status === 'reviewing',
              'bg-violet-400 animate-pulse': status === 'meeting',
            })} />
            {label}
          </div>
        ))}
      </div>

      {/* Office floor */}
      <div className="flex-1 relative rounded-xl border border-white/[0.06] bg-[#0a0a0a] overflow-hidden min-h-[400px]">
        {/* Grid floor pattern */}
        <div className="absolute inset-0 opacity-20"
          style={{
            backgroundImage: 'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
            backgroundSize: '40px 40px',
          }}
        />

        {/* Room labels */}
        <div className="absolute top-3 left-4 text-[10px] text-neutral-700 font-mono">WORKSPACE FLOOR</div>
        <div className="absolute bottom-3 right-4 text-[10px] text-neutral-700 font-mono">{active.length} agents active</div>

        {/* Agents */}
        {agents.map((agent, i) => (
          <PixelAgent
            key={agent.id}
            agent={agent}
            x={DESKS[i % DESKS.length].x}
            y={DESKS[i % DESKS.length].y}
          />
        ))}

        {/* Activity feed - bottom right */}
        <div className="absolute bottom-4 right-4 w-52 space-y-1">
          {agents.filter(a => a.status !== 'idle' && a.status !== 'offline').map(a => (
            <div key={a.id} className="flex items-center gap-1.5 text-[10px] text-neutral-500 bg-black/40 rounded px-2 py-1">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              <span className="font-mono">{a.name}</span>
              <span>—</span>
              <span>{STATUS_LABELS[a.status]}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Agent detail row */}
      <div className="grid grid-cols-3 gap-3 mt-4">
        {agents.map(a => (
          <div key={a.id} className={clsx('card flex items-center gap-2', a.status === 'offline' && 'opacity-40')}>
            <span className="text-lg">{a.emoji}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-white">{a.name}</div>
              <div className="text-xs text-neutral-500 truncate">{a.role}</div>
            </div>
            <div className={clsx('text-xs', {
              'text-neutral-400': a.status === 'idle',
              'text-cyan-400': a.status === 'researching',
              'text-blue-400': a.status === 'coding',
              'text-amber-400': a.status === 'reviewing',
              'text-violet-400': a.status === 'meeting',
              'text-neutral-700': a.status === 'offline',
            })}>
              {STATUS_LABELS[a.status]}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

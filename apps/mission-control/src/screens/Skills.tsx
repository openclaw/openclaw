import { useQuery } from '@tanstack/react-query'
import { getSkills } from '../api/openclaw'
import { useStore } from '../store'
import { Zap, Package, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'
import clsx from 'clsx'

// Known skills with metadata for enrichment
const SKILL_META: Record<string, { description: string; category: string; emoji: string }> = {
  'oralabs-cs': { description: 'Ora Labs customer service — handles order inquiries via WooCommerce API', category: 'Business', emoji: '🧬' },
  'youtube-shorts': { description: 'Generate YouTube Shorts scripts and metadata for content marketing', category: 'Content', emoji: '🎬' },
  'marketing': { description: 'Marketing copy, campaigns, and social media content creation', category: 'Content', emoji: '📢' },
  'email-manager': { description: 'Gmail drafting, inbox triage, and automated email responses', category: 'Comms', emoji: '✉️' },
  'discord-chat': { description: 'Discord server management and community engagement', category: 'Comms', emoji: '💬' },
  'playwright': { description: 'Browser automation for web scraping and testing', category: 'Dev', emoji: '🎭' },
  'github': { description: 'GitHub issue/PR management and code review assistance', category: 'Dev', emoji: '🐙' },
  'news-aggregator': { description: 'Aggregate and summarize news from multiple sources', category: 'Research', emoji: '📰' },
  'firecrawl': { description: 'Advanced web crawling and content extraction', category: 'Research', emoji: '🔥' },
  'notion': { description: 'Notion workspace management — pages, databases, tasks', category: 'Productivity', emoji: '📓' },
  'google-calendar': { description: 'Calendar management, event creation, and scheduling', category: 'Productivity', emoji: '📅' },
  'apollo': { description: 'B2B prospecting and contact enrichment via Apollo.io', category: 'Sales', emoji: '🎯' },
  'wordpress': { description: 'WordPress/WooCommerce site management and content publishing', category: 'Business', emoji: '🌐' },
  'obsidian': { description: 'Local knowledge base management in Obsidian', category: 'Knowledge', emoji: '🔮' },
}

const CATEGORY_COLORS: Record<string, string> = {
  'Business': 'bg-emerald-900/40 text-emerald-400',
  'Content': 'bg-rose-900/40 text-rose-400',
  'Comms': 'bg-blue-900/40 text-blue-400',
  'Dev': 'bg-violet-900/40 text-violet-400',
  'Research': 'bg-cyan-900/40 text-cyan-400',
  'Productivity': 'bg-amber-900/40 text-amber-400',
  'Sales': 'bg-orange-900/40 text-orange-400',
  'Knowledge': 'bg-pink-900/40 text-pink-400',
  'Unknown': 'bg-white/[0.05] text-neutral-500',
}

export function Skills() {
  const { agents } = useStore()
  const { data: skills = [], isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: getSkills,
    staleTime: 120_000,
  })

  // Merge real skills with known metadata
  const enriched = skills.map(s => ({
    ...s,
    ...(SKILL_META[s.name] ?? { description: s.description ?? 'No description available', category: 'Unknown', emoji: '⚡' }),
    enabled: true,
  }))

  // If no real skills yet, show the ones we know about
  const display = enriched.length > 0 ? enriched : Object.entries(SKILL_META).map(([name, meta]) => ({
    name, ...meta, version: undefined, enabled: true,
  }))

  const agentSkillCount = (skillName: string) =>
    agents.filter(a => a.skills.includes(skillName)).length

  const byCategory = display.reduce<Record<string, typeof display>>((acc, s) => {
    if (!acc[s.category]) acc[s.category] = []
    acc[s.category].push(s)
    return acc
  }, {})

  return (
    <div className="p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <p className="text-sm text-neutral-400">
            {display.length} skills installed
            {isLoading && <span className="text-neutral-600 ml-2">· loading from filesystem…</span>}
          </p>
        </div>
        <a
          href="https://openclaw.dev/skills"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-ghost flex items-center gap-1.5 text-xs"
        >
          <ExternalLink size={12} />
          Browse skill store
        </a>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {[
          { label: 'Total Installed', val: display.length, color: 'text-white' },
          { label: 'Active', val: display.filter(s => s.enabled).length, color: 'text-emerald-400' },
          { label: 'Categories', val: Object.keys(byCategory).length, color: 'text-blue-400' },
          { label: 'Assigned', val: display.filter(s => agentSkillCount(s.name) > 0).length, color: 'text-violet-400' },
        ].map(({ label, val, color }) => (
          <div key={label} className="card text-center">
            <div className={clsx('text-2xl font-bold', color)}>{val}</div>
            <div className="text-xs text-neutral-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* By category */}
      {Object.entries(byCategory).map(([cat, catSkills]) => (
        <div key={cat} className="mb-5">
          <div className="flex items-center gap-2 mb-2">
            <span className={clsx('badge text-[10px]', CATEGORY_COLORS[cat] ?? CATEGORY_COLORS['Unknown'])}>{cat}</span>
            <div className="flex-1 h-px bg-white/[0.04]" />
            <span className="text-xs text-neutral-600">{catSkills.length}</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {catSkills.map(skill => {
              const assignedAgents = agents.filter(a => a.skills.includes(skill.name))
              return (
                <div key={skill.name} className="card hover:border-white/[0.12] transition-all flex gap-3">
                  <div className="text-xl shrink-0">{skill.emoji}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-sm font-medium text-white">{skill.name}</span>
                      {skill.enabled
                        ? <CheckCircle2 size={12} className="text-emerald-400" />
                        : <AlertCircle size={12} className="text-neutral-600" />
                      }
                      {skill.version && <span className="text-[10px] text-neutral-600 font-mono">v{skill.version}</span>}
                    </div>
                    <p className="text-xs text-neutral-500 line-clamp-2 mb-1">{skill.description}</p>
                    {assignedAgents.length > 0 && (
                      <div className="flex gap-1">
                        {assignedAgents.map(a => (
                          <span key={a.id} className="text-[10px] text-neutral-500">{a.emoji} {a.name}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

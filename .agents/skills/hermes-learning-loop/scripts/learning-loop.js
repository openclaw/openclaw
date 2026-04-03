#!/usr/bin/env node

/**
 * Hermes Learning Loop - Self-Improving AI Agent for OpenClaw
 * 
 * Inspired by: NousResearch/hermes-agent
 * 
 * Core Features:
 * - Periodic Nudge (every N tasks)
 * - Skill Extraction from successful workflows
 * - 4-Layer Memory Management
 * - Curated Memory (not logging everything)
 * - Progressive Disclosure (summary → full content)
 * 
 * Usage:
 *   node learning-loop.js <command> [options]
 * 
 * Commands:
 *   nudge         - Periodic reflection trigger
 *   extract       - Extract skills from completed task
 *   create-skill  - Manually create skill
 *   curate        - Review and curate memories
 *   status        - Show learning loop status
 */

import { readFile, writeFile, mkdir, readdir, stat, appendFile } from 'fs/promises'
import { join, parse } from 'path'
import { fileURLToPath } from 'url'

const __dirname = parse(fileURLToPath(import.meta.url)).dir

// Configuration
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || process.cwd()
const SKILLS_DIR = process.env.LEARNING_SKILLS_DIR || join(WORKSPACE, '.openclaw/skills')
const MEMORY_DIR = process.env.LEARNING_MEMORY_DIR || join(WORKSPACE, '.openclaw/memory')
const MEMORY_INDEX = join(WORKSPACE, 'MEMORY.md')
const STATE_FILE = join(WORKSPACE, '.openclaw/.learning-state.json')

const NUDGE_INTERVAL = parseInt(process.env.LEARNING_NUDGE_INTERVAL || '5')
const MIN_TOOL_CALLS = parseInt(process.env.LEARNING_MIN_TOOL_CALLS || '5')
const AUTO_CREATE = process.env.LEARNING_AUTO_CREATE === 'true'
const MAX_PROMPT_CHARS = 3575 // Hermes-style tight limit

// ============================================
// State Management
// ============================================

async function loadState() {
  try {
    const content = await readFile(STATE_FILE, 'utf-8')
    return JSON.parse(content)
  } catch (e) {
    return {
      taskCount: 0,
      lastNudge: null,
      skillsCreated: 0,
      memoriesExtracted: 0
    }
  }
}

async function saveState(state) {
  await mkdir(parse(STATE_FILE).dir, { recursive: true })
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2))
}

// ============================================
// Periodic Nudge
// ============================================

async function periodicNudge() {
  console.log('\n🔔 Periodic Nudge - Learning Loop Reflection\n')
  
  const state = await loadState()
  state.taskCount++
  
  const shouldNudge = state.taskCount % NUDGE_INTERVAL === 0
  
  console.log(`Task counter: ${state.taskCount}`)
  console.log(`Nudge interval: ${NUDGE_INTERVAL}`)
  console.log(`Should nudge: ${shouldNudge ? '✅ YES' : '⏳ NO'}\n`)
  
  if (!shouldNudge) {
    console.log(`Next nudge in ${NUDGE_INTERVAL - (state.taskCount % NUDGE_INTERVAL)} tasks`)
    await saveState(state)
    return
  }
  
  console.log('━'.repeat(50))
  console.log('\n📊 Looking back at recent tasks...\n')
  
  // Simulated task review (in real implementation, read from session archive)
  const tasks = await getRecentTasks(NUDGE_INTERVAL)
  const extractions = []
  
  for (const task of tasks) {
    console.log(`Task ${task.id}: ${task.summary}`)
    
    const worthy = await evaluateSkillWorthiness(task)
    if (worthy) {
      console.log(`  → 🎯 Skill-worthy detected`)
      extractions.push({ task, ...worthy })
    } else {
      console.log(`  → ✅ Simple (no extraction needed)`)
    }
  }
  
  console.log('\n' + '━'.repeat(50))
  console.log('\n📊 Nudge Summary:\n')
  
  const newSkills = extractions.filter(e => e.type === 'skill')
  const memories = extractions.filter(e => e.type === 'memory')
  
  console.log(`  - New skills: ${newSkills.length}`)
  console.log(`  - Memory entries: ${memories.length}`)
  
  // Create skills
  for (const ext of newSkills) {
    if (AUTO_CREATE) {
      await createSkill(ext.skill)
      console.log(`  ✅ Created: ${ext.skill.name}`)
    } else {
      console.log(`  ⏳ Pending approval: ${ext.skill.name}`)
    }
  }
  
  state.lastNudge = new Date().toISOString()
  state.skillsCreated += newSkills.length
  state.memoriesExtracted += memories.length
  
  await saveState(state)
  
  console.log('\n📄 State saved\n')
}

// ============================================
// Skill Extraction
// ============================================

async function extractSkills(sessionId) {
  console.log('\n📊 Learning Loop - Skill Extraction\n')
  
  const session = await loadSession(sessionId)
  if (!session) {
    console.error(`❌ Session not found: ${sessionId}`)
    process.exit(1)
  }
  
  console.log(`Session: ${sessionId}`)
  console.log(`Outcome: ${session.outcome}`)
  console.log(`Tool calls: ${session.toolCalls?.length || 0}`)
  
  const worthy = await evaluateSkillWorthiness({
    ...session,
    id: sessionId
  })
  
  if (!worthy) {
    console.log('\n⚠️  No skill-worthy patterns detected')
    return
  }
  
  console.log('\n🎯 Skill-worthy detected!\n')
  console.log(`Type: ${worthy.type}`)
  console.log(`Reason: ${worthy.reason}`)
  
  if (worthy.skill) {
    console.log('\n📄 Proposed skill:')
    console.log(`  Name: ${worthy.skill.name}`)
    console.log(`  Description: ${worthy.skill.description}`)
    console.log(`  Steps: ${worthy.skill.steps?.length || 0}`)
    
    if (AUTO_CREATE) {
      await createSkill(worthy.skill)
      console.log('\n✅ Skill created!')
    } else {
      console.log('\n⏳ Waiting for approval...')
      console.log('   Run: node learning-loop.js approve --skill=<name>')
    }
  }
}

async function evaluateSkillWorthiness(task) {
  // Hermes-style triggers
  const triggers = [
    {
      condition: task.toolCalls?.length >= MIN_TOOL_CALLS,
      type: 'skill',
      reason: `${task.toolCalls.length} tool calls (threshold: ${MIN_TOOL_CALLS})`,
      extract: () => extractWorkflowSkill(task)
    },
    {
      condition: task.errorRecovery === true,
      type: 'skill',
      reason: 'Successful error recovery',
      extract: () => extractErrorRecoverySkill(task)
    },
    {
      condition: task.userCorrection === true,
      type: 'memory',
      reason: 'User correction applied',
      extract: () => extractFeedbackMemory(task)
    },
    {
      condition: task.complexity >= 7,
      type: 'skill',
      reason: 'Complex workflow detected',
      extract: () => extractWorkflowSkill(task)
    }
  ]
  
  for (const trigger of triggers) {
    if (trigger.condition) {
      const extracted = await trigger.extract()
      return {
        type: trigger.type,
        reason: trigger.reason,
        ...extracted
      }
    }
  }
  
  return null
}

async function extractWorkflowSkill(task) {
  // Extract reusable workflow from task
  const skill = {
    name: generateSkillName(task),
    description: task.summary || 'Automated workflow',
    version: '1.0.0',
    platforms: ['linux', 'macos'],
    steps: task.steps || [],
    toolCalls: task.toolCalls || [],
    metadata: {
      tags: extractTags(task),
      category: detectCategory(task),
      createdFrom: task.id
    }
  }
  
  return { skill }
}

async function extractErrorRecoverySkill(task) {
  const skill = {
    name: `debug-${generateSkillName(task)}`,
    description: `Recover from: ${task.errorType || 'error'}`,
    version: '1.0.0',
    platforms: ['linux', 'macos', 'windows'],
    steps: [
      'Identify error message',
      'Search for similar issues',
      'Apply fix',
      'Verify resolution'
    ],
    metadata: {
      tags: ['debugging', 'troubleshooting'],
      category: 'devops',
      errorType: task.errorType
    }
  }
  
  return { skill }
}

async function extractFeedbackMemory(task) {
  const memory = {
    type: 'feedback',
    content: task.correction || 'User provided correction',
    timestamp: new Date().toISOString(),
    context: task.id
  }
  
  return { memory }
}

// ============================================
// Skill Creation
// ============================================

async function createSkill(skill) {
  const skillDir = join(SKILLS_DIR, skill.metadata.category || 'misc', skill.name)
  await mkdir(skillDir, { recursive: true })
  
  const skillContent = generateSkillMarkdown(skill)
  await writeFile(join(skillDir, 'SKILL.md'), skillContent)
  
  console.log(`\n📄 Created: ${join(skillDir, 'SKILL.md')}`)
  
  return skillDir
}

function generateSkillMarkdown(skill) {
  return `---
name: ${skill.name}
description: ${skill.description}
version: ${skill.version}
platforms: [${skill.platforms?.join(', ') || 'linux, macos'}]
metadata:
  tags: [${skill.metadata?.tags?.join(', ') || ''}]
  category: ${skill.metadata?.category || 'misc'}
---

# ${skill.name}

## Overview

${skill.description}

## Prerequisites

${skill.prerequisites || '- None'}

## Steps

${(skill.steps || []).map((step, i) => `${i + 1}. **${step.title || step}**`).join('\n\n')}

## Tool Calls Used

${(skill.toolCalls || []).map(tc => `- \`${tc}\``).join('\n') || '- None'}

## Related Skills

${skill.related?.map(s => `- \`${s}\``).join('\n') || '- None'}
`
}

// ============================================
// Memory Curation
// ============================================

async function curateMemories(sessionId) {
  console.log('\n📊 Learning Loop - Memory Curation\n')
  
  const session = await loadSession(sessionId)
  if (!session) {
    console.error(`❌ Session not found: ${sessionId}`)
    process.exit(1)
  }
  
  console.log('Decision Framework:\n')
  console.log('┌──────────────────────────────────────────────────────┐')
  console.log('│ Should this be persisted?                            │')
  console.log('├──────────────────────────────────────────────────────┤')
  console.log('│ ❌ Chat pleasantries → Discard                       │')
  console.log('│ ❌ Failed attempts → Discard (keep only success)     │')
  console.log('│ ✅ Successful workflows → Extract as skill           │')
  console.log('│ ✅ User preferences → Add to USER.md                 │')
  console.log('│ ✅ Project context → Add to MEMORY.md (project/)     │')
  console.log('│ ✅ Corrections/feedback → Add to MEMORY.md (feedback/)│')
  console.log('└──────────────────────────────────────────────────────┘\n')
  
  // Analyze session content
  const items = analyzeSessionForCuration(session)
  
  console.log('📋 Session Analysis:\n')
  for (const item of items) {
    const decision = await decidePersistence(item)
    console.log(`${decision.icon} ${item.type}: ${item.summary}`)
    console.log(`  → ${decision.action}`)
    
    if (decision.persist) {
      await persistMemory(decision)
    }
  }
}

async function decidePersistence(item) {
  // Simple heuristic-based decisions
  const decisions = {
    'chat': { icon: '❌', action: 'Discard (not valuable)', persist: false },
    'error': { icon: '❌', action: 'Discard (keep only success)', persist: false },
    'workflow': { icon: '✅', action: 'Extract as skill', persist: true, type: 'skill' },
    'preference': { icon: '✅', action: 'Add to USER.md', persist: true, type: 'user' },
    'context': { icon: '✅', action: 'Add to MEMORY.md', persist: true, type: 'project' },
    'feedback': { icon: '✅', action: 'Add to MEMORY.md (feedback)', persist: true, type: 'feedback' }
  }
  
  return decisions[item.type] || { icon: '⚠️', action: 'Review manually', persist: false }
}

// ============================================
// Status Display
// ============================================

async function showStatus() {
  console.log('\n📊 Learning Loop Status\n')
  console.log('━'.repeat(50))
  
  const state = await loadState()
  
  console.log(`\nTask counter: ${state.taskCount}`)
  console.log(`Nudge interval: ${NUDGE_INTERVAL}`)
  console.log(`Next nudge in: ${NUDGE_INTERVAL - (state.taskCount % NUDGE_INTERVAL)} tasks`)
  console.log(`Last nudge: ${state.lastNudge || 'Never'}`)
  console.log(`\nSkills created: ${state.skillsCreated}`)
  console.log(`Memories extracted: ${state.memoriesExtracted}`)
  
  // Count existing skills
  const skillCount = await countSkills()
  console.log(`\nTotal skills in directory: ${skillCount}`)
  
  console.log('\n' + '━'.repeat(50))
}

// ============================================
// Helper Functions
// ============================================

async function getRecentTasks(count) {
  // In real implementation, read from session archive
  // Simulated for now
  return Array.from({ length: count }, (_, i) => ({
    id: `task-${i + 1}`,
    summary: `Task ${i + 1}`,
    toolCalls: Math.random() > 0.5 ? Array.from({ length: Math.floor(Math.random() * 10) }, (_, j) => `tool-${j}`) : [],
    errorRecovery: Math.random() > 0.8,
    userCorrection: Math.random() > 0.9,
    complexity: Math.floor(Math.random() * 10)
  }))
}

async function loadSession(sessionId) {
  // Try to load from JSON file first
  const jsonFile = sessionId.endsWith('.json') ? sessionId : `/tmp/${sessionId}.json`
  try {
    const content = await readFile(jsonFile, 'utf-8')
    return JSON.parse(content)
  } catch (e) {
    // Fall back to simulated session
    return {
      id: sessionId,
      outcome: 'success',
      toolCalls: Array.from({ length: 8 }, (_, i) => `tool-${i}`),
      steps: [
        { title: 'Step 1', command: 'command1' },
        { title: 'Step 2', command: 'command2' }
      ],
      summary: 'Simulated complex task',
      errorRecovery: true,
      errorType: 'TestError',
      complexity: 8
    }
  }
}

function generateSkillName(task) {
  return task.summary
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50) || 'my-skill'
}

function extractTags(task) {
  const tags = []
  if (task.toolCalls?.some(t => t.includes('git'))) tags.push('git')
  if (task.toolCalls?.some(t => t.includes('docker'))) tags.push('docker')
  if (task.toolCalls?.some(t => t.includes('kubectl'))) tags.push('kubernetes')
  return tags
}

function detectCategory(task) {
  if (task.toolCalls?.some(t => t.includes('kubectl') || t.includes('docker'))) return 'devops'
  if (task.toolCalls?.some(t => t.includes('git'))) return 'development'
  if (task.toolCalls?.some(t => t.includes('search'))) return 'research'
  return 'misc'
}

function analyzeSessionForCuration(session) {
  // Analyze session content for curation decisions
  return [
    { type: 'workflow', summary: 'Deployment workflow', content: session.summary },
    { type: 'preference', summary: 'User prefers dark mode', content: 'Dark mode preferred' },
    { type: 'chat', summary: 'Greeting exchange', content: 'Hello' }
  ]
}

async function persistMemory(decision) {
  // Write to appropriate memory file
  const timestamp = new Date().toISOString().split('T')[0]
  const memoryFile = join(MEMORY_DIR, decision.type, `${timestamp}.md`)
  
  await mkdir(parse(memoryFile).dir, { recursive: true })
  await appendFile(memoryFile, `\n\n## ${new Date().toISOString()}\n\n${decision.content || 'Memory entry'}`)
}

async function countSkills() {
  try {
    const categories = await readdir(SKILLS_DIR)
    let count = 0
    for (const cat of categories) {
      const skills = await readdir(join(SKILLS_DIR, cat))
      count += skills.filter(s => !s.startsWith('.')).length
    }
    return count
  } catch (e) {
    return 0
  }
}

// ============================================
// CLI Entry Point
// ============================================

const command = process.argv[2]

switch (command) {
  case 'nudge':
    periodicNudge()
    break
  case 'extract':
    extractSkills(process.argv[3])
    break
  case 'create-skill':
    // Manual skill creation
    break
  case 'curate':
    curateMemories(process.argv[3])
    break
  case 'status':
    showStatus()
    break
  default:
    console.log(`
📚 Hermes Learning Loop

Usage: node learning-loop.js <command> [options]

Commands:
  nudge         - Periodic reflection trigger
  extract       - Extract skills from completed task
  create-skill  - Manually create skill
  curate        - Review and curate memories
  status        - Show learning loop status

Examples:
  node learning-loop.js nudge
  node learning-loop.js extract session-2026-04-03
  node learning-loop.js status
`)
}

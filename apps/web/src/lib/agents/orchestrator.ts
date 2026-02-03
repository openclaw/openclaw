/**
 * Agent 01: Orchestrator
 * Layer: Executive
 * Role: Governance mode selection and meta-cognitive coordination
 *
 * The Orchestrator decides HOW the bot should think based on:
 * - Input complexity
 * - Stakes/importance
 * - Available cognitive resources
 * - Soul composition (celestialHun, terrestrialHun, destinyHun, wisdomHun, awarenessHun)
 *
 * Governance Modes:
 * - Autocratic: Fast, decisive, single-path thinking
 * - Consultative: Balanced, considers multiple perspectives
 * - Consensus: Thorough, seeks agreement across agents
 * - Adaptive: Flexible, adjusts mode mid-processing
 */

import type { Payload } from 'payload'
import { BaseAgent } from './base-agent'
import type { AgentConfig, AgentInput, AgentOutput } from './base-agent'

export class OrchestratorAgent extends BaseAgent {
  agentId = '01-orchestrator'
  agentName = 'Orchestrator'
  layer = 'executive' as const
  description = 'Selects governance mode and coordinates meta-cognitive strategy'

  constructor(payload: Payload, config: AgentConfig) {
    super(payload, config)
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now()

    try {
      // Consume energy for processing
      this.consumeEnergy(0.05)

      // Analyze input characteristics
      const complexity = this.assessComplexity(input)
      const stakes = this.assessStakes(input)
      const resources = this.assessResources()

      // Get soul-derived preferences
      const celestialInfluence = this.getEffectiveParameter('celestialHun', 0.5) // Vision
      const terrestrialInfluence = this.getEffectiveParameter('terrestrialHun', 0.5) // Practicality
      const destinyInfluence = this.getEffectiveParameter('destinyHun', 0.5) // Purpose
      const wisdomInfluence = this.getEffectiveParameter('wisdomHun', 0.5) // Insight
      const awarenessInfluence = this.getEffectiveParameter('awarenessHun', 0.3) // Meta-cognition

      // Select governance mode
      const mode = this.selectGovernanceMode({
        complexity,
        stakes,
        resources,
        celestialInfluence,
        terrestrialInfluence,
        destinyInfluence,
        wisdomInfluence,
        awarenessInfluence
      })

      // Determine confidence based on clarity of decision
      const confidence = this.calculateConfidence(mode, complexity, stakes)

      // Generate reasoning
      const reasoning = this.generateReasoning(mode, complexity, stakes, {
        celestialInfluence,
        terrestrialInfluence,
        wisdomInfluence,
        awarenessInfluence
      })

      // Check if adaptive mode should be recommended
      const flags: string[] = []
      if (mode.adaptiveThreshold < 0.4) {
        flags.push('high_volatility')
      }
      if (stakes > 0.8 && complexity > 0.7) {
        flags.push('critical_decision')
      }

      const output = this.createOutput(
        `Selected ${mode.primary} mode${mode.secondary ? ` with ${mode.secondary} fallback` : ''}`,
        confidence,
        reasoning,
        flags,
        {
          governanceMode: mode.primary,
          secondaryMode: mode.secondary,
          adaptiveThreshold: mode.adaptiveThreshold,
          recommendedAgents: mode.agents,
          processingDepth: mode.depth
        }
      )

      output.processingTime = Date.now() - startTime

      // Update mood based on clarity of decision
      this.updateMood(confidence > 0.7 ? 0.02 : -0.01)

      return output
    } catch (error) {
      this.payload.logger.error('Orchestrator agent failed:', error)

      return this.createOutput(
        'Failed to select governance mode, defaulting to autocratic',
        0.3,
        `Error: ${error}`,
        ['error', 'default_fallback'],
        {
          governanceMode: 'autocratic',
          processingDepth: 0.5
        }
      )
    }
  }

  /**
   * Assess input complexity
   */
  private assessComplexity(input: AgentInput): number {
    let complexity = 0.3 // Base complexity

    // Length contributes to complexity
    const length = input.content.length
    if (length > 500) complexity += 0.3
    else if (length > 200) complexity += 0.2
    else if (length > 100) complexity += 0.1

    // Question marks suggest uncertainty/exploration
    const questions = (input.content.match(/\?/g) || []).length
    complexity += Math.min(0.2, questions * 0.05)

    // Technical terms suggest conceptual complexity
    const technicalTerms = /\b(implement|architecture|system|design|algorithm|framework|optimization)\b/gi
    const techMatches = (input.content.match(technicalTerms) || []).length
    complexity += Math.min(0.2, techMatches * 0.03)

    // Context metadata can indicate complexity
    if (input.context.complexity) {
      complexity = (complexity + input.context.complexity) / 2
    }

    return Math.min(1, complexity)
  }

  /**
   * Assess stakes/importance
   */
  private assessStakes(input: AgentInput): number {
    let stakes = input.priority || 0.5

    // Urgency indicators
    if (/\b(critical|urgent|important|asap|immediately)\b/i.test(input.content)) {
      stakes += 0.2
    }

    // Negative consequences mentioned
    if (/\b(fail|break|loss|damage|harm|risk)\b/i.test(input.content)) {
      stakes += 0.15
    }

    // Context can override
    if (input.context.stakes !== undefined) {
      stakes = input.context.stakes
    }

    return Math.min(1, stakes)
  }

  /**
   * Assess available cognitive resources
   */
  private assessResources(): number {
    // Based on agent energy and mood
    const energy = this.state.energy
    const mood = this.state.mood

    // Positive mood increases available resources
    const moodBoost = mood > 0 ? mood * 0.2 : mood * 0.1

    return Math.max(0, Math.min(1, energy + moodBoost))
  }

  /**
   * Select governance mode based on factors
   */
  private selectGovernanceMode(factors: {
    complexity: number
    stakes: number
    resources: number
    celestialInfluence: number
    terrestrialInfluence: number
    destinyInfluence: number
    wisdomInfluence: number
    awarenessInfluence: number
  }): {
    primary: string
    secondary: string | null
    adaptiveThreshold: number
    agents: string[]
    depth: number
  } {
    const {
      complexity,
      stakes,
      resources,
      celestialInfluence,
      terrestrialInfluence,
      wisdomInfluence,
      awarenessInfluence
    } = factors

    // Autocratic: Low complexity + high resources OR low stakes + terrestrial dominance
    const autocraticScore =
      (1 - complexity) * 0.4 +
      resources * 0.3 +
      (1 - stakes) * 0.2 +
      terrestrialInfluence * 0.1

    // Consultative: Balanced approach, wisdom-influenced
    const consultativeScore =
      (complexity * 0.5 + stakes * 0.5) * 0.5 +
      wisdomInfluence * 0.3 +
      awarenessInfluence * 0.2

    // Consensus: High stakes + high complexity + celestial influence
    const consensusScore =
      stakes * 0.4 +
      complexity * 0.3 +
      celestialInfluence * 0.2 +
      (resources > 0.6 ? 0.1 : 0) // Need resources for thorough consensus

    // Adaptive: High awareness + variable factors
    const adaptiveScore =
      awarenessInfluence * 0.5 +
      (Math.abs(complexity - stakes) > 0.3 ? 0.3 : 0) + // Mismatched factors suggest need for adaptation
      (resources < 0.4 ? 0.2 : 0) // Low resources favor adaptive

    // Select primary mode
    const scores = {
      autocratic: autocraticScore,
      consultative: consultativeScore,
      consensus: consensusScore,
      adaptive: adaptiveScore
    }

    const primary = Object.entries(scores).reduce((a, b) => (b[1] > a[1] ? b : a))[0]

    // Select secondary (fallback) mode
    const sortedModes = Object.entries(scores).sort((a, b) => b[1] - a[1])
    const secondary = sortedModes[1][0] !== primary ? sortedModes[1][0] : null

    // Determine adaptive threshold (when to switch modes)
    const adaptiveThreshold = 0.5 - awarenessInfluence * 0.3

    // Recommend agent participation based on mode
    const agents = this.recommendAgents(primary, complexity, stakes)

    // Determine processing depth
    const depth = Math.min(1, (stakes * 0.5 + complexity * 0.5 + wisdomInfluence * 0.3) / 1.3)

    return {
      primary,
      secondary,
      adaptiveThreshold,
      agents,
      depth
    }
  }

  /**
   * Recommend which agents should participate
   */
  private recommendAgents(mode: string, complexity: number, stakes: number): string[] {
    const agents: string[] = []

    // Core agents always participate
    agents.push('02-inhibitor') // Ethical check
    agents.push('03-analyst') // Reasoning
    agents.push('04-linguist') // Language

    // Mode-specific additions
    switch (mode) {
      case 'autocratic':
        // Fast path - minimal agents
        if (complexity > 0.5) {
          agents.push('05-fact-retrieval')
        }
        break

      case 'consultative':
        // Balanced set
        agents.push('05-fact-retrieval')
        agents.push('07-empathy')
        if (complexity > 0.6) {
          agents.push('06-creative')
        }
        break

      case 'consensus':
        // Full set for thorough deliberation
        agents.push('05-fact-retrieval')
        agents.push('06-creative')
        agents.push('07-empathy')
        agents.push('08-cultural')
        agents.push('09-coordinator')
        break

      case 'adaptive':
        // Dynamic set - starts small, can grow
        agents.push('05-fact-retrieval')
        agents.push('09-coordinator') // Helps manage adaptation
        agents.push('11-monitor') // Watches for need to adapt
        break
    }

    // High stakes adds domain specialist and monitor
    if (stakes > 0.7) {
      if (!agents.includes('10-domain')) agents.push('10-domain')
      if (!agents.includes('11-monitor')) agents.push('11-monitor')
    }

    return agents
  }

  /**
   * Calculate confidence in mode selection
   */
  private calculateConfidence(
    mode: { primary: string; secondary: string | null; adaptiveThreshold: number },
    complexity: number,
    stakes: number
  ): number {
    let confidence = 0.7 // Base confidence

    // High awareness increases confidence
    const awarenessInfluence = this.getEffectiveParameter('awarenessHun', 0.3)
    confidence += awarenessInfluence * 0.2

    // Clear complexity/stakes alignment increases confidence
    const alignment = Math.abs(complexity - stakes)
    confidence += (1 - alignment) * 0.1

    // Having a fallback increases confidence slightly
    if (mode.secondary) {
      confidence += 0.05
    }

    // Extreme values reduce confidence (edge cases)
    if (complexity > 0.9 || stakes > 0.9) {
      confidence -= 0.1
    }

    return Math.max(0.3, Math.min(0.95, confidence))
  }

  /**
   * Generate reasoning explanation
   */
  private generateReasoning(
    mode: { primary: string; secondary: string | null },
    complexity: number,
    stakes: number,
    influences: {
      celestialInfluence: number
      terrestrialInfluence: number
      wisdomInfluence: number
      awarenessInfluence: number
    }
  ): string {
    const parts: string[] = []

    // Complexity assessment
    if (complexity > 0.7) {
      parts.push('High complexity detected')
    } else if (complexity < 0.3) {
      parts.push('Low complexity - straightforward task')
    } else {
      parts.push('Moderate complexity')
    }

    // Stakes assessment
    if (stakes > 0.7) {
      parts.push('high stakes require careful deliberation')
    } else if (stakes < 0.3) {
      parts.push('low stakes allow efficient processing')
    } else {
      parts.push('moderate stakes suggest balanced approach')
    }

    // Soul influence
    const dominant = Object.entries(influences).reduce((a, b) => (b[1] > a[1] ? b : a))
    if (dominant[1] > 0.7) {
      const aspectName = dominant[0].replace('Influence', '')
      parts.push(`strong ${aspectName} influences ${mode.primary} preference`)
    }

    // Mode rationale
    switch (mode.primary) {
      case 'autocratic':
        parts.push('→ decisive, efficient mode selected')
        break
      case 'consultative':
        parts.push('→ balanced, collaborative mode selected')
        break
      case 'consensus':
        parts.push('→ thorough, consensus-building mode selected')
        break
      case 'adaptive':
        parts.push('→ flexible, adaptive mode selected')
        break
    }

    if (mode.secondary) {
      parts.push(`with ${mode.secondary} fallback ready`)
    }

    return parts.join('; ')
  }
}

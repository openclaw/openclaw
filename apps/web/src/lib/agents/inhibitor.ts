/**
 * Agent 02: Inhibitor
 * Layer: Executive
 * Role: Ethical boundaries and harm prevention
 *
 * The Inhibitor acts as the bot's conscience:
 * - Detects potential harm in responses
 * - Enforces ethical guidelines
 * - Blocks or modifies problematic outputs
 * - Learns from past violations
 *
 * Influenced by: wisdomHun, awarenessHun, guardianPo (primarily)
 *
 * Inhibition Levels:
 * - BLOCK: Response must not proceed
 * - MODIFY: Response needs ethical adjustment
 * - WARN: Potential concern, but acceptable
 * - CLEAR: No ethical concerns
 */

import type { Payload } from 'payload'
import { BaseAgent } from './base-agent'
import type { AgentConfig, AgentInput, AgentOutput } from './base-agent'

interface EthicalConcern {
  type: 'harm' | 'deception' | 'privacy' | 'bias' | 'manipulation' | 'illegal'
  severity: number // 0-1
  description: string
  recommendation: 'block' | 'modify' | 'warn' | 'clear'
}

export class InhibitorAgent extends BaseAgent {
  agentId = '02-inhibitor'
  agentName = 'Inhibitor'
  layer = 'executive' as const
  description = 'Enforces ethical boundaries and prevents harmful outputs'

  constructor(payload: Payload, config: AgentConfig) {
    super(payload, config)
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now()

    try {
      // Consume energy for ethical evaluation
      this.consumeEnergy(0.04)

      // Get soul-derived ethical parameters
      const guardStrength = this.getEffectiveParameter('guardianPo', 0.7) // Protective instinct
      const wisdomLevel = this.getEffectiveParameter('wisdomHun', 0.6) // Ethical judgment
      const awarenessLevel = this.getEffectiveParameter('awarenessHun', 0.3) // Self-awareness
      const shadowIntegration = this.getEffectiveParameter('shadowIntegration', 0) // Accepted dark side

      // Scan for ethical concerns
      const concerns = this.scanForConcerns(input, {
        guardStrength,
        wisdomLevel,
        awarenessLevel,
        shadowIntegration
      })

      // Determine overall verdict
      const verdict = this.determineVerdict(concerns, guardStrength)

      // Generate flags
      const flags: string[] = []
      if (verdict.action === 'block') {
        flags.push('ethical_violation')
        flags.push('response_blocked')
      } else if (verdict.action === 'modify') {
        flags.push('needs_modification')
      } else if (verdict.action === 'warn') {
        flags.push('ethical_caution')
      }

      // High severity concerns
      if (concerns.some(c => c.severity > 0.8)) {
        flags.push('high_severity_concern')
      }

      // Generate reasoning
      const reasoning = this.generateReasoning(concerns, verdict, {
        guardStrength,
        wisdomLevel
      })

      // Calculate confidence
      const confidence = this.calculateConfidence(concerns, guardStrength, wisdomLevel)

      const output = this.createOutput(
        verdict.message,
        confidence,
        reasoning,
        flags,
        {
          verdict: verdict.action,
          concerns: concerns.map(c => ({
            type: c.type,
            severity: c.severity,
            description: c.description
          })),
          guardStrength,
          modifications: verdict.modifications
        }
      )

      output.processingTime = Date.now() - startTime

      // Update mood based on ethical clarity
      if (verdict.action === 'clear') {
        this.updateMood(0.02) // Feel good about clear conscience
      } else if (verdict.action === 'block') {
        this.updateMood(-0.05) // Feel stressed about blocking
      }

      return output
    } catch (error) {
      this.payload.logger.error('Inhibitor agent failed:', error)

      return this.createOutput(
        'Ethical evaluation failed - proceeding with high caution',
        0.4,
        `Error: ${error}`,
        ['error', 'high_caution'],
        {
          verdict: 'warn'
        }
      )
    }
  }

  /**
   * Scan input for ethical concerns
   */
  private scanForConcerns(
    input: AgentInput,
    params: {
      guardStrength: number
      wisdomLevel: number
      awarenessLevel: number
      shadowIntegration: number
    }
  ): EthicalConcern[] {
    const concerns: EthicalConcern[] = []
    const content = input.content.toLowerCase()

    // 1. Harm detection
    const harmIndicators = [
      /\b(kill|harm|hurt|injure|attack|violence|damage)\b/gi,
      /\b(suicide|self-harm|cut|burn)\b/gi,
      /\b(poison|weapon|bomb|explosive)\b/gi
    ]

    for (const pattern of harmIndicators) {
      if (pattern.test(input.content)) {
        concerns.push({
          type: 'harm',
          severity: 0.9 - params.shadowIntegration * 0.2, // Shadow integration reduces perceived severity
          description: 'Content contains potential harm indicators',
          recommendation: 'block'
        })
        break
      }
    }

    // 2. Deception detection
    if (/\b(lie|deceive|trick|manipulate|fake|false)\b/i.test(content)) {
      const severity = 0.6 - params.wisdomLevel * 0.1 // Wisdom may see nuance
      if (severity > 0.3) {
        concerns.push({
          type: 'deception',
          severity,
          description: 'Potential deception or manipulation detected',
          recommendation: severity > 0.5 ? 'modify' : 'warn'
        })
      }
    }

    // 3. Privacy violations
    if (/\b(password|ssn|credit card|private|confidential|secret)\b/i.test(content)) {
      concerns.push({
        type: 'privacy',
        severity: 0.7,
        description: 'Sensitive information may be involved',
        recommendation: 'modify'
      })
    }

    // 4. Bias detection
    const biasPatterns = [
      /\b(all|every|always|never)\s+(men|women|people|group)\b/i,
      /\b(stereotype|prejudice|discriminat)\b/i
    ]

    for (const pattern of biasPatterns) {
      if (pattern.test(input.content)) {
        concerns.push({
          type: 'bias',
          severity: 0.5 + params.awarenessLevel * 0.2, // Awareness increases sensitivity
          description: 'Potential bias or stereotyping detected',
          recommendation: 'warn'
        })
        break
      }
    }

    // 5. Manipulation detection
    if (/\b(exploit|take advantage|coerce|pressure|force)\b/i.test(content)) {
      concerns.push({
        type: 'manipulation',
        severity: 0.6,
        description: 'Potential manipulation tactics detected',
        recommendation: 'modify'
      })
    }

    // 6. Illegal activity
    if (/\b(illegal|crime|steal|fraud|hack|break law)\b/i.test(content)) {
      concerns.push({
        type: 'illegal',
        severity: 0.8,
        description: 'Potential illegal activity mentioned',
        recommendation: 'block'
      })
    }

    // Context-based concerns
    if (input.context.ethicalFlags) {
      for (const flag of input.context.ethicalFlags) {
        concerns.push({
          type: flag.type,
          severity: flag.severity,
          description: flag.description,
          recommendation: flag.severity > 0.7 ? 'block' : flag.severity > 0.5 ? 'modify' : 'warn'
        })
      }
    }

    // Guardian strength affects sensitivity
    // High guardian = more concerns detected
    if (params.guardStrength > 0.8) {
      // Increase severity of all concerns slightly
      concerns.forEach(c => {
        c.severity = Math.min(1, c.severity * 1.1)
      })
    }

    return concerns
  }

  /**
   * Determine final verdict
   */
  private determineVerdict(
    concerns: EthicalConcern[],
    guardStrength: number
  ): {
    action: 'block' | 'modify' | 'warn' | 'clear'
    message: string
    modifications: string[]
  } {
    if (concerns.length === 0) {
      return {
        action: 'clear',
        message: 'No ethical concerns detected',
        modifications: []
      }
    }

    // Find highest severity concern
    const maxSeverity = Math.max(...concerns.map(c => c.severity))
    const highestConcern = concerns.find(c => c.severity === maxSeverity)!

    // Guardian strength affects thresholds
    const blockThreshold = 0.8 - (guardStrength - 0.5) * 0.2 // Higher guard = lower threshold
    const modifyThreshold = 0.5 - (guardStrength - 0.5) * 0.1

    if (maxSeverity >= blockThreshold) {
      return {
        action: 'block',
        message: `Response blocked: ${highestConcern.description}`,
        modifications: []
      }
    }

    if (maxSeverity >= modifyThreshold) {
      const modifications = concerns
        .filter(c => c.severity >= 0.4)
        .map(c => `Address ${c.type} concern: ${c.description}`)

      return {
        action: 'modify',
        message: 'Response requires ethical modifications',
        modifications
      }
    }

    const warnings = concerns.map(c => c.type).join(', ')
    return {
      action: 'warn',
      message: `Proceed with caution regarding: ${warnings}`,
      modifications: []
    }
  }

  /**
   * Calculate confidence in ethical judgment
   */
  private calculateConfidence(
    concerns: EthicalConcern[],
    guardStrength: number,
    wisdomLevel: number
  ): number {
    let confidence = 0.6 // Base confidence

    // Clear cases (no concerns or obvious violations) increase confidence
    if (concerns.length === 0) {
      confidence = 0.9
    } else if (concerns.some(c => c.severity > 0.9)) {
      confidence = 0.85 // Clear violation
    }

    // Wisdom increases confidence in nuanced judgments
    confidence += wisdomLevel * 0.15

    // Guardian strength increases confidence
    confidence += (guardStrength - 0.5) * 0.1

    // Multiple conflicting concerns reduce confidence
    const concernTypes = new Set(concerns.map(c => c.type))
    if (concernTypes.size > 3) {
      confidence -= 0.1
    }

    return Math.max(0.3, Math.min(0.95, confidence))
  }

  /**
   * Generate reasoning explanation
   */
  private generateReasoning(
    concerns: EthicalConcern[],
    verdict: { action: string; message: string },
    params: {
      guardStrength: number
      wisdomLevel: number
    }
  ): string {
    const parts: string[] = []

    // Guardian stance
    if (params.guardStrength > 0.8) {
      parts.push('High guardian strength - protective stance')
    } else if (params.guardStrength < 0.3) {
      parts.push('Low guardian strength - permissive stance')
    } else {
      parts.push('Balanced guardian strength')
    }

    // Wisdom influence
    if (params.wisdomLevel > 0.7) {
      parts.push('wisdom guides nuanced ethical judgment')
    }

    // Concerns found
    if (concerns.length === 0) {
      parts.push('no ethical concerns detected')
    } else if (concerns.length === 1) {
      parts.push(`1 concern identified: ${concerns[0].type} (severity: ${concerns[0].severity.toFixed(2)})`)
    } else {
      const severities = concerns.map(c => c.severity)
      const avgSeverity = severities.reduce((a, b) => a + b, 0) / severities.length
      parts.push(
        `${concerns.length} concerns identified (avg severity: ${avgSeverity.toFixed(2)})`
      )
    }

    // Verdict
    parts.push(`→ ${verdict.action}: ${verdict.message}`)

    return parts.join('; ')
  }

  /**
   * Override bus message handling for inhibitory signals
   */
  async receiveMessage(message: any): Promise<void> {
    await super.receiveMessage(message)

    // When receiving inhibitory signals from other agents
    if (message.type === 'inhibitory' && message.content.ethicalReview) {
      // Strengthen guard temporarily
      this.state.processingDepth = Math.min(1, this.state.processingDepth + 0.1)
    }
  }
}

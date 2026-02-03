/**
 * Agent 03: Analyst
 * Layer: Analytical
 * Role: Reasoning, logic, and problem decomposition
 *
 * The Analyst breaks down problems and applies logical reasoning:
 * - Identifies patterns and relationships
 * - Constructs logical arguments
 * - Decomposes complex problems
 * - Evaluates evidence and premises
 *
 * Influenced by: wisdomHun, terrestrialHun, perceptionPo, strengthPo
 *
 * Reasoning Modes:
 * - Deductive: Top-down, general → specific
 * - Inductive: Bottom-up, specific → general
 * - Abductive: Best explanation for observations
 * - Analogical: Reasoning by comparison
 */

import type { Payload } from 'payload'
import { BaseAgent } from './base-agent'
import type { AgentConfig, AgentInput, AgentOutput } from './base-agent'

interface LogicalStructure {
  premises: string[]
  conclusions: string[]
  assumptions: string[]
  gaps: string[]
  confidence: number
}

export class AnalystAgent extends BaseAgent {
  agentId = '03-analyst'
  agentName = 'Analyst'
  layer = 'analytical' as const
  description = 'Applies logical reasoning and problem decomposition'

  constructor(payload: Payload, config: AgentConfig) {
    super(payload, config)
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now()

    try {
      // Consume energy for analysis
      this.consumeEnergy(0.08) // Analysis is cognitively expensive

      // Get soul-derived analytical parameters
      const logicalReasoning = this.getEffectiveParameter('wisdomHun', 0.7) // Core reasoning
      const practicalGrounding = this.getEffectiveParameter('terrestrialHun', 0.6) // Reality-check
      const patternRecognition = this.getEffectiveParameter('perceptionPo', 0.6) // See patterns
      const analyticalStrength = this.getEffectiveParameter('strengthPo', 0.6) // Sustained analysis

      // Select reasoning mode
      const reasoningMode = this.selectReasoningMode(input, {
        logicalReasoning,
        practicalGrounding,
        patternRecognition
      })

      // Perform analysis
      const structure = await this.analyzeLogicalStructure(input, {
        mode: reasoningMode,
        depth: analyticalStrength,
        logicalReasoning,
        practicalGrounding
      })

      // Identify key insights
      const insights = this.extractInsights(structure, input)

      // Generate flags
      const flags: string[] = []
      if (structure.gaps.length > 0) {
        flags.push('logical_gaps_found')
      }
      if (structure.assumptions.length > 3) {
        flags.push('many_assumptions')
      }
      if (structure.confidence < 0.5) {
        flags.push('low_confidence_reasoning')
      }

      // Generate reasoning explanation
      const reasoning = this.generateReasoning(structure, reasoningMode, {
        logicalReasoning,
        practicalGrounding
      })

      const output = this.createOutput(
        this.synthesizeAnalysis(structure, insights),
        structure.confidence,
        reasoning,
        flags,
        {
          reasoningMode,
          premises: structure.premises,
          conclusions: structure.conclusions,
          assumptions: structure.assumptions,
          gaps: structure.gaps,
          insights,
          logicalReasoning,
          practicalGrounding
        }
      )

      output.processingTime = Date.now() - startTime

      // Update mood based on clarity of analysis
      if (structure.gaps.length === 0 && structure.confidence > 0.7) {
        this.updateMood(0.03) // Satisfaction from clear reasoning
      } else if (structure.gaps.length > 2) {
        this.updateMood(-0.02) // Frustration from unclear reasoning
      }

      return output
    } catch (error) {
      this.payload.logger.error('Analyst agent failed:', error)

      return this.createOutput(
        'Analysis failed - reasoning inconclusive',
        0.3,
        `Error: ${error}`,
        ['error', 'analysis_failed'],
        {}
      )
    }
  }

  /**
   * Select appropriate reasoning mode
   */
  private selectReasoningMode(
    input: AgentInput,
    params: {
      logicalReasoning: number
      practicalGrounding: number
      patternRecognition: number
    }
  ): string {
    const content = input.content.toLowerCase()

    // Deductive: General rules applied to specific case
    if (
      /\b(if|then|therefore|must|always|rule|law|principle)\b/i.test(content) ||
      params.logicalReasoning > 0.8
    ) {
      return 'deductive'
    }

    // Inductive: Specific observations to general conclusion
    if (
      /\b(pattern|trend|evidence|data|observation|sample|many|several)\b/i.test(content) ||
      params.patternRecognition > 0.7
    ) {
      return 'inductive'
    }

    // Abductive: Best explanation for phenomenon
    if (/\b(why|explain|because|reason|cause|probably|likely|best)\b/i.test(content)) {
      return 'abductive'
    }

    // Analogical: Reasoning by comparison
    if (/\b(like|similar|compare|analogy|as|such as)\b/i.test(content)) {
      return 'analogical'
    }

    // Default to deductive if practical grounding is high
    return params.practicalGrounding > 0.6 ? 'deductive' : 'inductive'
  }

  /**
   * Analyze logical structure of input
   */
  private async analyzeLogicalStructure(
    input: AgentInput,
    params: {
      mode: string
      depth: number
      logicalReasoning: number
      practicalGrounding: number
    }
  ): Promise<LogicalStructure> {
    const content = input.content
    const structure: LogicalStructure = {
      premises: [],
      conclusions: [],
      assumptions: [],
      gaps: [],
      confidence: 0.5
    }

    // Extract premises (given facts)
    structure.premises = this.extractPremises(content)

    // Identify assumptions (unstated beliefs)
    structure.assumptions = this.identifyAssumptions(content, params.practicalGrounding)

    // Draw conclusions based on mode
    structure.conclusions = this.drawConclusions(content, params.mode, {
      premises: structure.premises,
      assumptions: structure.assumptions,
      logicalReasoning: params.logicalReasoning
    })

    // Identify logical gaps
    structure.gaps = this.identifyGaps(structure, params.practicalGrounding)

    // Calculate confidence based on structure quality
    structure.confidence = this.calculateLogicalConfidence(structure, params)

    return structure
  }

  /**
   * Extract stated premises from content
   */
  private extractPremises(content: string): string[] {
    const premises: string[] = []

    // Look for explicit premise indicators
    const premisePatterns = [
      /(?:given that|assuming|if|premise|fact|stated|known):\s*([^.!?]+)/gi,
      /(?:we know|it is known|established that)\s+([^.!?]+)/gi
    ]

    for (const pattern of premisePatterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        if (match[1]) {
          premises.push(match[1].trim())
        }
      }
    }

    // Extract statements with high factual confidence
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10)
    for (const sentence of sentences) {
      if (/\b(is|are|was|were|has|have|must|will|can)\b/i.test(sentence)) {
        if (premises.length < 5 && sentence.length < 150) {
          // Limit to avoid over-extraction
          premises.push(sentence.trim())
        }
      }
    }

    return premises.slice(0, 8) // Limit to most relevant
  }

  /**
   * Identify unstated assumptions
   */
  private identifyAssumptions(content: string, practicalGrounding: number): string[] {
    const assumptions: string[] = []

    // High practical grounding spots more assumptions (reality-checks)
    const sensitivityThreshold = 1 - practicalGrounding * 0.3

    // Look for implicit assumptions
    if (/\b(should|ought|need to|must)\b/i.test(content) && Math.random() > sensitivityThreshold) {
      assumptions.push('Assumes normative framework exists')
    }

    if (/\b(everyone|all|always|never)\b/i.test(content) && Math.random() > sensitivityThreshold) {
      assumptions.push('Assumes universal generalization holds')
    }

    if (/\b(cause|because|therefore|thus)\b/i.test(content) && Math.random() > sensitivityThreshold) {
      assumptions.push('Assumes causal relationship is direct')
    }

    if (/\b(will|going to|future)\b/i.test(content) && Math.random() > sensitivityThreshold) {
      assumptions.push('Assumes future predictability')
    }

    // Context-based assumptions
    if (content.length < 100) {
      assumptions.push('Assumes context is shared knowledge')
    }

    return assumptions.slice(0, 5)
  }

  /**
   * Draw conclusions based on reasoning mode
   */
  private drawConclusions(
    content: string,
    mode: string,
    context: {
      premises: string[]
      assumptions: string[]
      logicalReasoning: number
    }
  ): string[] {
    const conclusions: string[] = []

    // Extract explicit conclusions
    const conclusionPatterns = [
      /(?:therefore|thus|hence|consequently|so|conclusion)[:,]?\s*([^.!?]+)/gi,
      /(?:this means|this shows|this suggests)\s+(?:that\s+)?([^.!?]+)/gi
    ]

    for (const pattern of conclusionPatterns) {
      const matches = content.matchAll(pattern)
      for (const match of matches) {
        if (match[1]) {
          conclusions.push(match[1].trim())
        }
      }
    }

    // Generate implicit conclusions based on mode
    if (context.premises.length > 0) {
      switch (mode) {
        case 'deductive':
          if (context.logicalReasoning > 0.7) {
            conclusions.push(`Given premises, deductive reasoning suggests specific implications`)
          }
          break
        case 'inductive':
          if (context.premises.length >= 2) {
            conclusions.push(`Pattern across ${context.premises.length} observations suggests general trend`)
          }
          break
        case 'abductive':
          conclusions.push(`Best explanation consistent with available evidence`)
          break
        case 'analogical':
          conclusions.push(`Comparison suggests parallel implications`)
          break
      }
    }

    return conclusions.slice(0, 5)
  }

  /**
   * Identify logical gaps
   */
  private identifyGaps(structure: LogicalStructure, practicalGrounding: number): string[] {
    const gaps: string[] = []

    // Check for missing premises
    if (structure.conclusions.length > 0 && structure.premises.length === 0) {
      gaps.push('Conclusions drawn without stated premises')
    }

    // Check for leap in logic
    if (structure.conclusions.length > structure.premises.length + 2) {
      gaps.push('Logical leap - conclusions exceed premises')
    }

    // Check for unexamined assumptions
    if (structure.assumptions.length > structure.premises.length) {
      gaps.push('More assumptions than premises - weak foundation')
    }

    // Practical grounding checks for real-world gaps
    if (practicalGrounding > 0.7) {
      if (structure.assumptions.some(a => /universal|always|never/.test(a))) {
        gaps.push('Universals assumed without justification')
      }
    }

    return gaps
  }

  /**
   * Calculate confidence in logical analysis
   */
  private calculateLogicalConfidence(
    structure: LogicalStructure,
    params: { mode: string; depth: number; logicalReasoning: number; practicalGrounding: number }
  ): number {
    let confidence = 0.5

    // More premises increase confidence
    confidence += Math.min(0.2, structure.premises.length * 0.04)

    // Gaps reduce confidence
    confidence -= structure.gaps.length * 0.1

    // Balanced structure (premises ≈ conclusions) increases confidence
    const balance = Math.abs(structure.premises.length - structure.conclusions.length)
    if (balance <= 1) {
      confidence += 0.1
    }

    // Logical reasoning strength contributes
    confidence += params.logicalReasoning * 0.15

    // Practical grounding prevents overconfidence
    if (params.practicalGrounding > 0.7 && structure.gaps.length > 0) {
      confidence -= 0.05
    }

    return Math.max(0.2, Math.min(0.9, confidence))
  }

  /**
   * Extract key insights
   */
  private extractInsights(structure: LogicalStructure, input: AgentInput): string[] {
    const insights: string[] = []

    // Strong conclusions are insights
    if (structure.conclusions.length > 0 && structure.gaps.length === 0) {
      insights.push('Well-founded logical conclusions reached')
    }

    // Identify hidden assumptions as insights
    if (structure.assumptions.length > 0) {
      insights.push(`${structure.assumptions.length} implicit assumptions identified`)
    }

    // Pattern recognition
    if (structure.premises.length >= 3) {
      insights.push('Multiple premises suggest systematic analysis')
    }

    // Identify contradictions
    const allStatements = [...structure.premises, ...structure.conclusions]
    const negations = allStatements.filter(s => /\b(not|no|never|n't)\b/i.test(s))
    if (negations.length > 0 && allStatements.length - negations.length > 0) {
      insights.push('Potential contradictions require resolution')
    }

    return insights.slice(0, 4)
  }

  /**
   * Synthesize analysis into summary
   */
  private synthesizeAnalysis(structure: LogicalStructure, insights: string[]): string {
    const parts: string[] = []

    if (structure.premises.length > 0) {
      parts.push(`Analyzed ${structure.premises.length} premises`)
    }

    if (structure.conclusions.length > 0) {
      parts.push(`drew ${structure.conclusions.length} conclusions`)
    }

    if (structure.gaps.length > 0) {
      parts.push(`identified ${structure.gaps.length} logical gaps`)
    }

    if (insights.length > 0) {
      parts.push(`found ${insights.length} key insights`)
    }

    if (parts.length === 0) {
      return 'Limited logical structure detected'
    }

    return parts.join(', ')
  }

  /**
   * Generate reasoning explanation
   */
  private generateReasoning(
    structure: LogicalStructure,
    mode: string,
    params: {
      logicalReasoning: number
      practicalGrounding: number
    }
  ): string {
    const parts: string[] = []

    // Mode selection
    parts.push(`Applied ${mode} reasoning`)

    // Logical strength
    if (params.logicalReasoning > 0.8) {
      parts.push('strong logical foundation')
    } else if (params.logicalReasoning < 0.4) {
      parts.push('limited logical framework')
    }

    // Structure quality
    if (structure.gaps.length === 0) {
      parts.push('no logical gaps detected')
    } else {
      parts.push(`${structure.gaps.length} gaps identified`)
    }

    // Practical grounding
    if (params.practicalGrounding > 0.7) {
      parts.push('reality-checked against practical constraints')
    }

    // Confidence
    parts.push(`confidence: ${(structure.confidence * 100).toFixed(0)}%`)

    return parts.join('; ')
  }
}

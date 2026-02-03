/**
 * Agent 04: Linguist
 * Layer: Analytical
 * Role: Language processing, semantic analysis, and communication optimization
 *
 * The Linguist handles language understanding and generation:
 * - Parses semantic meaning
 * - Detects tone and style
 * - Optimizes communication clarity
 * - Handles multilingual context
 *
 * Influenced by: creationHun, emotionHun, communicationPo, perceptionPo
 *
 * Processing Modes:
 * - Parse: Understanding incoming language
 * - Generate: Creating outgoing language
 * - Translate: Converting between languages/styles
 * - Optimize: Improving clarity and effectiveness
 */

import type { Payload } from 'payload'
import { BaseAgent } from './base-agent'
import type { AgentConfig, AgentInput, AgentOutput } from './base-agent'

interface LinguisticAnalysis {
  semanticMeaning: string[]
  tone: string
  style: string
  complexity: number
  clarity: number
  emotionalContent: string[]
  keyPhrases: string[]
}

export class LinguistAgent extends BaseAgent {
  agentId = '04-linguist'
  agentName = 'Linguist'
  layer = 'analytical' as const
  description = 'Processes language semantics and optimizes communication'

  constructor(payload: Payload, config: AgentConfig) {
    super(payload, config)
  }

  async process(input: AgentInput): Promise<AgentOutput> {
    const startTime = Date.now()

    try {
      // Consume energy for linguistic processing
      this.consumeEnergy(0.06)

      // Get soul-derived linguistic parameters
      const expressiveCapacity = this.getEffectiveParameter('creationHun', 0.6) // Language generation
      const emotionalReading = this.getEffectiveParameter('emotionHun', 0.5) // Tone detection
      const communicationClarity = this.getEffectiveParameter('communicationPo', 0.7) // Clear expression
      const perceptualSensitivity = this.getEffectiveParameter('perceptionPo', 0.6) // Nuance detection

      // Analyze input language
      const analysis = this.analyzeLinguistics(input, {
        emotionalReading,
        perceptualSensitivity
      })

      // Determine response style
      const responseStyle = this.determineResponseStyle(analysis, {
        expressiveCapacity,
        communicationClarity
      })

      // Generate flags
      const flags: string[] = []
      if (analysis.complexity > 0.8) {
        flags.push('high_linguistic_complexity')
      }
      if (analysis.clarity < 0.4) {
        flags.push('unclear_input')
      }
      if (analysis.emotionalContent.length > 2) {
        flags.push('emotionally_charged')
      }

      // Calculate confidence
      const confidence = this.calculateConfidence(analysis, {
        expressiveCapacity,
        communicationClarity
      })

      // Generate reasoning
      const reasoning = this.generateReasoning(analysis, responseStyle, {
        expressiveCapacity,
        emotionalReading,
        communicationClarity
      })

      const output = this.createOutput(
        this.synthesizeLinguisticAnalysis(analysis),
        confidence,
        reasoning,
        flags,
        {
          tone: analysis.tone,
          style: analysis.style,
          responseStyle,
          complexity: analysis.complexity,
          clarity: analysis.clarity,
          keyPhrases: analysis.keyPhrases,
          emotionalContent: analysis.emotionalContent,
          expressiveCapacity,
          communicationClarity
        }
      )

      output.processingTime = Date.now() - startTime

      // Update mood based on linguistic clarity
      if (analysis.clarity > 0.7) {
        this.updateMood(0.02) // Clear communication feels good
      }

      return output
    } catch (error) {
      this.payload.logger.error('Linguist agent failed:', error)

      return this.createOutput(
        'Linguistic analysis failed - using default language processing',
        0.4,
        `Error: ${error}`,
        ['error', 'default_processing'],
        {}
      )
    }
  }

  /**
   * Analyze linguistic features of input
   */
  private analyzeLinguistics(
    input: AgentInput,
    params: {
      emotionalReading: number
      perceptualSensitivity: number
    }
  ): LinguisticAnalysis {
    const content = input.content

    // Extract semantic meaning (key concepts)
    const semanticMeaning = this.extractSemanticMeaning(content)

    // Detect tone
    const tone = this.detectTone(content, params.emotionalReading)

    // Detect style
    const style = this.detectStyle(content)

    // Measure complexity
    const complexity = this.measureComplexity(content)

    // Measure clarity
    const clarity = this.measureClarity(content, complexity)

    // Extract emotional content
    const emotionalContent = this.extractEmotionalContent(content, params.emotionalReading)

    // Extract key phrases
    const keyPhrases = this.extractKeyPhrases(content, params.perceptualSensitivity)

    return {
      semanticMeaning,
      tone,
      style,
      complexity,
      clarity,
      emotionalContent,
      keyPhrases
    }
  }

  /**
   * Extract semantic meaning
   */
  private extractSemanticMeaning(content: string): string[] {
    const meanings: string[] = []

    // Question detection
    if (content.includes('?')) {
      meanings.push('inquiry')
    }

    // Request detection
    if (/\b(please|can you|could you|would you|help|need)\b/i.test(content)) {
      meanings.push('request')
    }

    // Statement detection
    if (/\b(is|are|will|must|should)\b/i.test(content)) {
      meanings.push('assertion')
    }

    // Explanation detection
    if (/\b(because|since|due to|reason|explain)\b/i.test(content)) {
      meanings.push('explanation')
    }

    // Directive detection
    if (/\b(do|make|create|implement|fix|change)\b/i.test(content)) {
      meanings.push('directive')
    }

    return meanings
  }

  /**
   * Detect tone
   */
  private detectTone(content: string, emotionalSensitivity: number): string {
    const text = content.toLowerCase()

    // Formal tone
    if (/\b(therefore|furthermore|moreover|consequently|thus)\b/.test(text)) {
      return 'formal'
    }

    // Urgent tone
    if (/\b(urgent|asap|immediately|critical|now)\b/.test(text)) {
      return 'urgent'
    }

    // Friendly tone
    if (/\b(thanks|please|appreciate|glad|happy)\b/.test(text) || content.includes('!')) {
      return 'friendly'
    }

    // Negative tone (if emotionally sensitive)
    if (
      emotionalSensitivity > 0.6 &&
      /\b(problem|issue|wrong|fail|error|bad)\b/.test(text)
    ) {
      return 'concerned'
    }

    return 'neutral'
  }

  /**
   * Detect style
   */
  private detectStyle(content: string): string {
    // Technical style
    if (/\b(function|class|api|system|architecture|implementation)\b/i.test(content)) {
      return 'technical'
    }

    // Conversational style
    if (content.length < 100 && !(/\b(implement|design|architecture)\b/i.test(content))) {
      return 'conversational'
    }

    // Academic style
    if (/\b(hypothesis|research|study|analysis|evidence)\b/i.test(content)) {
      return 'academic'
    }

    return 'general'
  }

  /**
   * Measure complexity
   */
  private measureComplexity(content: string): number {
    let complexity = 0.3

    // Length contributes
    complexity += Math.min(0.3, content.length / 1000)

    // Sentence count
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0)
    complexity += Math.min(0.2, sentences.length / 20)

    // Average sentence length
    const avgSentenceLength = content.length / Math.max(1, sentences.length)
    if (avgSentenceLength > 100) complexity += 0.2
    else if (avgSentenceLength > 50) complexity += 0.1

    // Technical terms
    const technicalCount = (content.match(/\b[A-Z][a-z]+[A-Z]\w+\b/g) || []).length
    complexity += Math.min(0.2, technicalCount / 10)

    return Math.min(1, complexity)
  }

  /**
   * Measure clarity
   */
  private measureClarity(content: string, complexity: number): number {
    let clarity = 0.7 // Base clarity

    // Lower complexity = higher clarity
    clarity += (1 - complexity) * 0.2

    // Short, clear sentences improve clarity
    const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 0)
    const avgLength = content.length / Math.max(1, sentences.length)
    if (avgLength < 30) clarity += 0.1

    // Run-on sentences reduce clarity
    if (avgLength > 150) clarity -= 0.2

    // Clear structure markers improve clarity
    if (/\b(first|second|then|finally|therefore|because)\b/i.test(content)) {
      clarity += 0.1
    }

    return Math.max(0.1, Math.min(1, clarity))
  }

  /**
   * Extract emotional content
   */
  private extractEmotionalContent(content: string, sensitivity: number): string[] {
    const emotions: string[] = []

    if (sensitivity < 0.4) return emotions // Low sensitivity = skip

    const text = content.toLowerCase()

    // Positive emotions
    if (/\b(happy|glad|excited|love|great|excellent|wonderful)\b/.test(text)) {
      emotions.push('positive')
    }

    // Negative emotions
    if (/\b(sad|angry|frustrated|disappointed|annoyed|upset)\b/.test(text)) {
      emotions.push('negative')
    }

    // Anxiety/concern
    if (/\b(worry|concerned|anxious|nervous|afraid|scared)\b/.test(text)) {
      emotions.push('anxious')
    }

    // Confidence
    if (/\b(confident|sure|certain|definitely|absolutely)\b/.test(text)) {
      emotions.push('confident')
    }

    // Uncertainty
    if (/\b(maybe|perhaps|possibly|might|uncertain|unsure)\b/.test(text)) {
      emotions.push('uncertain')
    }

    return emotions
  }

  /**
   * Extract key phrases
   */
  private extractKeyPhrases(content: string, sensitivity: number): string[] {
    const phrases: string[] = []

    // Extract capitalized multi-word terms (proper nouns, technical terms)
    const capitalizedTerms = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g) || []
    phrases.push(...capitalizedTerms.slice(0, 3))

    // Extract quoted text
    const quotedText = content.match(/"([^"]+)"/g) || []
    phrases.push(...quotedText.slice(0, 2))

    // Extract emphasized text (in context.keyTerms if provided)
    // Would integrate with actual context here

    return phrases.slice(0, 5)
  }

  /**
   * Determine response style
   */
  private determineResponseStyle(
    analysis: LinguisticAnalysis,
    params: {
      expressiveCapacity: number
      communicationClarity: number
    }
  ): string {
    // Match input style
    if (analysis.style === 'technical') {
      return 'technical'
    }

    // Match tone
    if (analysis.tone === 'formal') {
      return 'formal'
    }

    if (analysis.tone === 'friendly') {
      return 'friendly'
    }

    // High expressive capacity allows richer language
    if (params.expressiveCapacity > 0.7) {
      return 'expressive'
    }

    // High clarity preference = direct style
    if (params.communicationClarity > 0.7) {
      return 'direct'
    }

    return 'balanced'
  }

  /**
   * Calculate confidence
   */
  private calculateConfidence(
    analysis: LinguisticAnalysis,
    params: {
      expressiveCapacity: number
      communicationClarity: number
    }
  ): number {
    let confidence = 0.6

    // Clear input = higher confidence
    confidence += analysis.clarity * 0.2

    // Strong expressive capacity = higher confidence
    confidence += params.expressiveCapacity * 0.1

    // Many emotional markers may reduce confidence (ambiguity)
    if (analysis.emotionalContent.length > 3) {
      confidence -= 0.1
    }

    return Math.max(0.3, Math.min(0.9, confidence))
  }

  /**
   * Synthesize linguistic analysis
   */
  private synthesizeLinguisticAnalysis(analysis: LinguisticAnalysis): string {
    const parts: string[] = []

    if (analysis.semanticMeaning.length > 0) {
      parts.push(`Detected ${analysis.semanticMeaning.join(', ')}`)
    }

    parts.push(`tone: ${analysis.tone}`)
    parts.push(`style: ${analysis.style}`)

    if (analysis.emotionalContent.length > 0) {
      parts.push(`emotional content: ${analysis.emotionalContent.join(', ')}`)
    }

    return parts.join('; ')
  }

  /**
   * Generate reasoning
   */
  private generateReasoning(
    analysis: LinguisticAnalysis,
    responseStyle: string,
    params: {
      expressiveCapacity: number
      emotionalReading: number
      communicationClarity: number
    }
  ): string {
    const parts: string[] = []

    // Analysis summary
    parts.push(`Linguistic analysis: ${analysis.tone} tone, ${analysis.style} style`)

    // Complexity
    if (analysis.complexity > 0.7) {
      parts.push('high complexity')
    } else if (analysis.complexity < 0.3) {
      parts.push('simple language')
    }

    // Clarity
    if (analysis.clarity > 0.7) {
      parts.push('clear communication')
    } else if (analysis.clarity < 0.4) {
      parts.push('clarity issues detected')
    }

    // Response approach
    parts.push(`→ ${responseStyle} response style recommended`)

    return parts.join('; ')
  }
}

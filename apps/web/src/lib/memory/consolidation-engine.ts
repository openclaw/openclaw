/**
 * Memory Consolidation Engine
 * Implements hippocampus-inspired memory consolidation
 * Working Memory → Short-term → Long-term → Archived
 *
 * Based on recent neuroscience research:
 * - Episodic memories encoded in hippocampus
 * - Replayed during rest to extract semantic knowledge
 * - Consolidation strengthens important memories
 * - Forgetting curve for unused memories
 */

import type { Payload } from 'payload'

export interface ConsolidationConfig {
  shortTermToLongTermThreshold: number // Hours before consolidation
  longTermToArchivedThreshold: number // Days before archiving
  importanceDecayRate: number // How fast importance decays
  retrievalStrengthening: number // How much retrieval strengthens memory
  baseRetention: number // Base retention rate (0-1)
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  shortTermToLongTermThreshold: 24, // 24 hours
  longTermToArchivedThreshold: 90, // 90 days
  importanceDecayRate: 0.1,
  retrievalStrengthening: 0.1,
  baseRetention: 0.7
}

export class MemoryConsolidationEngine {
  private payload: Payload
  private config: ConsolidationConfig
  private consolidationTimer: NodeJS.Timeout | null = null

  constructor(payload: Payload, config?: Partial<ConsolidationConfig>) {
    this.payload = payload
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Start automatic consolidation
    this.startConsolidation()
  }

  /**
   * Start periodic consolidation process
   */
  private startConsolidation(): void {
    // Run consolidation every hour
    this.consolidationTimer = setInterval(() => {
      this.runConsolidation().catch((error) => {
        this.payload.logger.error(`Consolidation error: ${error}`)
      })
    }, 60 * 60 * 1000) // 1 hour

    this.payload.logger.info('Memory consolidation engine started')
  }

  /**
   * Stop consolidation process
   */
  stop(): void {
    if (this.consolidationTimer) {
      clearInterval(this.consolidationTimer)
      this.consolidationTimer = null
    }
  }

  /**
   * Run complete consolidation process
   */
  async runConsolidation(): Promise<{
    shortToLong: number
    longToArchived: number
    semanticExtractions: number
    forgotten: number
  }> {
    this.payload.logger.info('Starting memory consolidation cycle...')

    const stats = {
      shortToLong: 0,
      longToArchived: 0,
      semanticExtractions: 0,
      forgotten: 0
    }

    // Step 1: Short-term → Long-term consolidation
    stats.shortToLong = await this.consolidateShortToLong()

    // Step 2: Long-term → Archived
    stats.longToArchived = await this.archiveOldMemories()

    // Step 3: Extract semantic knowledge from episodic memories
    stats.semanticExtractions = await this.extractSemanticKnowledge()

    // Step 4: Apply forgetting curve
    stats.forgotten = await this.applyForgettingCurve()

    this.payload.logger.info(
      `Consolidation complete: ${stats.shortToLong} short→long, ` +
      `${stats.longToArchived} long→archived, ` +
      `${stats.semanticExtractions} semantic extractions, ` +
      `${stats.forgotten} forgotten`
    )

    return stats
  }

  /**
   * Consolidate short-term memories to long-term
   * (Hippocampus-inspired consolidation during "rest")
   */
  private async consolidateShortToLong(): Promise<number> {
    const thresholdTime = Date.now() - this.config.shortTermToLongTermThreshold * 60 * 60 * 1000

    const shortTermMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        consolidationLevel: {
          equals: 'short-term'
        },
        createdAt: {
          less_than: new Date(thresholdTime).toISOString()
        }
      },
      limit: 1000
    })

    let consolidated = 0

    for (const memory of shortTermMemories.docs) {
      // Only consolidate if importance is high enough
      const memoryData = memory as any
      if (memoryData.importance >= 0.4) {
        await this.payload.update({
          collection: 'bot-memory',
          id: memory.id,
          data: {
            consolidationLevel: 'long-term'
          }
        })
        consolidated++
      } else {
        // Low importance memories forgotten
        await this.payload.delete({
          collection: 'bot-memory',
          id: memory.id
        })
      }
    }

    return consolidated
  }

  /**
   * Archive old long-term memories
   */
  private async archiveOldMemories(): Promise<number> {
    const thresholdTime = Date.now() - this.config.longTermToArchivedThreshold * 24 * 60 * 60 * 1000

    const oldMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        consolidationLevel: {
          equals: 'long-term'
        },
        createdAt: {
          less_than: new Date(thresholdTime).toISOString()
        },
        retrievalCount: {
          less_than: 5 // Only archive infrequently accessed memories
        }
      },
      limit: 1000
    })

    let archived = 0

    for (const memory of oldMemories.docs) {
      await this.payload.update({
        collection: 'bot-memory',
        id: memory.id,
        data: {
          consolidationLevel: 'archived'
        }
      })
      archived++
    }

    return archived
  }

  /**
   * Extract semantic knowledge from episodic memories
   * (Conversion of experiences into facts and concepts)
   */
  private async extractSemanticKnowledge(): Promise<number> {
    const episodicMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        memoryType: {
          equals: 'episodic'
        },
        consolidationLevel: {
          in: ['long-term', 'archived']
        },
        'episodicData.semanticExtractionDone': {
          equals: false
        }
      },
      limit: 100
    })

    let extracted = 0

    for (const memory of episodicMemories.docs) {
      const memoryData = memory as any

      // Extract patterns and concepts from the episodic memory
      // This would ideally use an LLM to analyze the memory
      // For now, basic extraction based on importance and emotion

      if (memoryData.importance > 0.6) {
        const concepts = await this.extractConceptsFromEpisode(memoryData)

        for (const concept of concepts) {
          // Create or update semantic memory
          await this.payload.create({
            collection: 'bot-memory',
            data: {
              bot: memoryData.bot,
              memoryType: 'semantic',
              consolidationLevel: 'long-term',
              importance: memoryData.importance * 0.8,
              semanticData: {
                concept: concept.concept,
                definition: concept.definition,
                category: concept.category,
                confidence: concept.confidence,
                learnedFrom: [
                  {
                    episodicMemoryId: memory.id
                  }
                ]
              }
            }
          })
        }

        // Mark as extracted
        await this.payload.update({
          collection: 'bot-memory',
          id: memory.id,
          data: {
            'episodicData.semanticExtractionDone': true
          }
        })

        extracted++
      }
    }

    return extracted
  }

  /**
   * Extract concepts from episodic memory
   * (This is a simplified version - ideally would use LLM)
   */
  private async extractConceptsFromEpisode(memory: any): Promise<Array<{
    concept: string
    definition: string
    category: 'fact' | 'skill' | 'belief' | 'value' | 'pattern'
    confidence: number
  }>> {
    const concepts: Array<{
      concept: string
      definition: string
      category: 'fact' | 'skill' | 'belief' | 'value' | 'pattern'
      confidence: number
    }> = []

    // Simple pattern extraction from description
    const description = memory.episodicData?.description || ''

    // Extract potential concepts (in real implementation, use NLP/LLM)
    if (description.length > 50) {
      const emotionalValence = memory.emotionalContext?.valence || 0

      // High valence events often teach values
      if (emotionalValence > 0.5) {
        concepts.push({
          concept: `Positive experience: ${description.substring(0, 50)}`,
          definition: 'This type of experience is valuable',
          category: 'value',
          confidence: emotionalValence
        })
      }

      // Events with high arousal teach importance
      const emotionalArousal = memory.emotionalContext?.arousal || 0
      if (emotionalArousal > 0.7) {
        concepts.push({
          concept: `Important pattern: ${description.substring(0, 50)}`,
          definition: 'This pattern requires attention',
          category: 'pattern',
          confidence: emotionalArousal
        })
      }
    }

    return concepts
  }

  /**
   * Apply forgetting curve (Ebbinghaus)
   * Retention = Base * e^(-time/decay_constant)
   */
  private async applyForgettingCurve(): Promise<number> {
    const allMemories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        consolidationLevel: {
          in: ['short-term', 'long-term']
        }
      },
      limit: 10000
    })

    let forgotten = 0
    const now = Date.now()

    for (const memory of allMemories.docs) {
      const memoryData = memory as any
      const age = now - new Date(memoryData.createdAt).getTime()
      const daysSinceCreation = age / (1000 * 60 * 60 * 24)

      // Calculate retention based on forgetting curve
      const decayConstant = 30 // days
      const importanceModifier = 1 + (memoryData.importance * 2) // Important memories decay slower
      const retrievalBonus = Math.min(memoryData.retrievalCount * 0.1, 0.5) // Retrieval strengthens

      const retention = this.config.baseRetention *
        Math.exp(-daysSinceCreation / (decayConstant * importanceModifier)) +
        retrievalBonus

      // If retention drops below threshold, forget the memory
      if (retention < 0.1) {
        await this.payload.delete({
          collection: 'bot-memory',
          id: memory.id
        })
        forgotten++
      } else {
        // Update importance based on retention
        const newImportance = Math.max(0, memoryData.importance * retention)
        await this.payload.update({
          collection: 'bot-memory',
          id: memory.id,
          data: {
            importance: newImportance
          }
        })
      }
    }

    return forgotten
  }

  /**
   * Strengthen memory through retrieval
   * (Memory reconsolidation - memories become stronger when recalled)
   */
  async strengthenMemory(memoryId: string): Promise<void> {
    try {
      const memory = await this.payload.findByID({
        collection: 'bot-memory',
        id: memoryId
      })

      const memoryData = memory as any
      const newImportance = Math.min(1, memoryData.importance + this.config.retrievalStrengthening)
      const newRetrievalCount = (memoryData.retrievalCount || 0) + 1

      await this.payload.update({
        collection: 'bot-memory',
        id: memoryId,
        data: {
          importance: newImportance,
          retrievalCount: newRetrievalCount,
          lastRetrieved: new Date().toISOString()
        }
      })

      // If memory was archived, promote back to long-term due to retrieval
      if (memoryData.consolidationLevel === 'archived') {
        await this.payload.update({
          collection: 'bot-memory',
          id: memoryId,
          data: {
            consolidationLevel: 'long-term'
          }
        })
      }
    } catch (error) {
      this.payload.logger.error(`Failed to strengthen memory ${memoryId}: ${error}`)
    }
  }

  /**
   * Get consolidation statistics for a bot
   */
  async getStats(botId: string): Promise<{
    working: number
    shortTerm: number
    longTerm: number
    archived: number
    totalMemories: number
    averageImportance: number
  }> {
    const memories = await this.payload.find({
      collection: 'bot-memory',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 10000
    })

    const stats = {
      working: 0,
      shortTerm: 0,
      longTerm: 0,
      archived: 0,
      totalMemories: memories.totalDocs,
      averageImportance: 0
    }

    let totalImportance = 0

    memories.docs.forEach((memory: any) => {
      switch (memory.consolidationLevel) {
        case 'working':
          stats.working++
          break
        case 'short-term':
          stats.shortTerm++
          break
        case 'long-term':
          stats.longTerm++
          break
        case 'archived':
          stats.archived++
          break
      }
      totalImportance += memory.importance || 0
    })

    stats.averageImportance = memories.totalDocs > 0 ? totalImportance / memories.totalDocs : 0

    return stats
  }
}

/**
 * Singleton instance
 */
let consolidationEngine: MemoryConsolidationEngine | null = null

export function getConsolidationEngine(payload: Payload): MemoryConsolidationEngine {
  if (!consolidationEngine) {
    consolidationEngine = new MemoryConsolidationEngine(payload)
  }
  return consolidationEngine
}

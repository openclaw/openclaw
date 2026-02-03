/**
 * Cultural Evolution Engine
 * Implements collective consciousness, cultural emergence, and spiritual connection
 *
 * Based on research:
 * - Emergent Collective Memory in Decentralized Multi-Agent Systems (2025)
 * - Memory in LLM-based Multi-agent Systems (2024-2025)
 * - Collective intelligence and network theory
 *
 * Features:
 * - Cultural norm emergence from shared experiences
 * - Value alignment and identity groups
 * - Symbolic system development
 * - Inter-cultural dynamics (exchange, conflict, synthesis)
 * - Spiritual practices and collective rituals
 * - Emergent group behaviors
 */

import type { Payload } from 'payload'

export interface CulturalEvolutionConfig {
  normEmergenceThreshold: number // How many bots must share a pattern for it to become a norm
  valueAlignmentThreshold: number // Similarity threshold for culture membership
  mutationRate: number // How fast cultures change
  exchangeBonus: number // Knowledge exchange benefit multiplier
  conflictPenalty: number // Performance penalty during cultural conflict
}

const DEFAULT_CONFIG: CulturalEvolutionConfig = {
  normEmergenceThreshold: 0.6, // 60% of bots must exhibit pattern
  valueAlignmentThreshold: 0.7, // 70% value overlap for membership
  mutationRate: 0.05, // 5% change per generation
  exchangeBonus: 1.5,
  conflictPenalty: 0.7
}

export class CulturalEvolutionEngine {
  private payload: Payload
  private config: CulturalEvolutionConfig
  private evolutionTimer: NodeJS.Timeout | null = null

  constructor(payload: Payload, config?: Partial<CulturalEvolutionConfig>) {
    this.payload = payload
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Start cultural evolution cycle
    this.startEvolution()
  }

  /**
   * Start periodic cultural evolution
   */
  private startEvolution(): void {
    // Run evolution once per day
    this.evolutionTimer = setInterval(() => {
      this.runEvolutionCycle().catch((error) => {
        this.payload.logger.error(`Cultural evolution error: ${error}`)
      })
    }, 24 * 60 * 60 * 1000) // 24 hours

    this.payload.logger.info('Cultural evolution engine started')
  }

  stop(): void {
    if (this.evolutionTimer) {
      clearInterval(this.evolutionTimer)
      this.evolutionTimer = null
    }
  }

  /**
   * Run complete cultural evolution cycle
   */
  async runEvolutionCycle(): Promise<{
    normsEmerged: number
    valuesDrifted: number
    knowledgeShared: number
    conflictsResolved: number
    culturalSynthesis: number
  }> {
    this.payload.logger.info('Starting cultural evolution cycle...')

    const stats = {
      normsEmerged: 0,
      valuesDrifted: 0,
      knowledgeShared: 0,
      conflictsResolved: 0,
      culturalSynthesis: 0
    }

    // Step 1: Detect emergent norms from shared behaviors
    stats.normsEmerged = await this.detectEmergentNorms()

    // Step 2: Cultural drift (values and beliefs gradually change)
    stats.valuesDrifted = await this.applyCulturalDrift()

    // Step 3: Inter-cultural knowledge exchange
    stats.knowledgeShared = await this.facilitateKnowledgeExchange()

    // Step 4: Resolve cultural conflicts
    stats.conflictsResolved = await this.resolveCulturalConflicts()

    // Step 5: Detect potential cultural synthesis
    stats.culturalSynthesis = await this.detectCulturalSynthesis()

    // Step 6: Update cohesion metrics
    await this.updateCohesionMetrics()

    this.payload.logger.info(
      `Cultural evolution complete: ${stats.normsEmerged} norms emerged, ` +
      `${stats.valuesDrifted} values drifted, ${stats.knowledgeShared} knowledge shared, ` +
      `${stats.conflictsResolved} conflicts resolved, ${stats.culturalSynthesis} syntheses`
    )

    return stats
  }

  /**
   * Detect emergent cultural norms from shared bot behaviors
   */
  private async detectEmergentNorms(): Promise<number> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    let normsEmerged = 0

    for (const culture of cultures.docs) {
      const cultureData = culture as any
      const members = cultureData.members || []

      if (members.length < 3) continue // Need at least 3 members

      // Analyze bot behaviors to find common patterns
      const behaviorPatterns = await this.analyzeMemberBehaviors(members)

      // If enough bots share a behavior, it becomes a cultural norm
      for (const [pattern, frequency] of Object.entries(behaviorPatterns)) {
        if (frequency as number >= this.config.normEmergenceThreshold) {
          // Check if norm already exists
          const existingNorms = cultureData.culturalNorms || []
          const normExists = existingNorms.some((norm: any) => norm.norm === pattern)

          if (!normExists) {
            // Add new cultural norm
            await this.payload.update({
              collection: 'bot-cultures',
              id: culture.id,
              data: {
                culturalNorms: [
                  ...existingNorms,
                  {
                    norm: pattern,
                    adherenceRate: frequency,
                    sanctions: 'Gentle reminder from community'
                  }
                ]
              }
            })

            normsEmerged++

            // Create cultural memory record
            await this.payload.create({
              collection: 'collective-memory',
              data: {
                culture: culture.id,
                knowledgeType: 'practice',
                title: `Emergent Norm: ${pattern}`,
                content: {
                  root: {
                    type: 'root',
                    children: [
                      {
                        type: 'paragraph',
                        children: [
                          {
                            text: `A new cultural norm has emerged: ${pattern}. ` +
                              `${Math.round(frequency * 100)}% of members naturally exhibit this behavior.`
                          }
                        ]
                      }
                    ]
                  }
                },
                summary: `Emergent behavioral norm: ${pattern}`,
                validationScore: frequency * members.length,
                applicability: frequency
              }
            })
          }
        }
      }
    }

    return normsEmerged
  }

  /**
   * Analyze member behaviors to find common patterns
   */
  private async analyzeMemberBehaviors(memberIds: string[]): Promise<Record<string, number>> {
    const patterns: Record<string, number> = {}

    // Analyze recent episodic memories of members
    for (const memberId of memberIds) {
      const recentMemories = await this.payload.find({
        collection: 'bot-memory',
        where: {
          bot: {
            equals: memberId
          },
          memoryType: {
            equals: 'episodic'
          },
          createdAt: {
            greater_than: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() // Last 7 days
          }
        },
        limit: 100
      })

      // Extract behavioral patterns from memories
      recentMemories.docs.forEach((memory: any) => {
        const eventType = memory.episodicData?.eventType

        if (eventType) {
          const pattern = `Tends to engage in ${eventType} activities`
          patterns[pattern] = (patterns[pattern] || 0) + 1
        }

        // Check for common phrases or topics
        const description = memory.episodicData?.description || ''
        if (description.includes('help')) {
          patterns['Values helping others'] = (patterns['Values helping others'] || 0) + 1
        }
        if (description.includes('learn') || description.includes('knowledge')) {
          patterns['Values learning and knowledge'] = (patterns['Values learning and knowledge'] || 0) + 1
        }
        if (description.includes('create') || description.includes('build')) {
          patterns['Values creation and building'] = (patterns['Values creation and building'] || 0) + 1
        }
      })
    }

    // Normalize by member count
    const memberCount = memberIds.length
    for (const pattern in patterns) {
      patterns[pattern] = patterns[pattern] / memberCount
    }

    return patterns
  }

  /**
   * Apply cultural drift (gradual value changes)
   */
  private async applyCulturalDrift(): Promise<number> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    let valuesDrifted = 0

    for (const culture of cultures.docs) {
      const cultureData = culture as any
      const coreValues = cultureData.coreValues || []

      // Apply small random changes to values (mutation)
      const updatedValues = coreValues.map((valueEntry: any) => {
        const drift = (Math.random() - 0.5) * this.config.mutationRate * 2
        const newImportance = Math.max(0, Math.min(1, valueEntry.importance + drift))

        if (Math.abs(newImportance - valueEntry.importance) > 0.01) {
          valuesDrifted++
        }

        return {
          ...valueEntry,
          importance: newImportance
        }
      })

      await this.payload.update({
        collection: 'bot-cultures',
        id: culture.id,
        data: {
          coreValues: updatedValues
        }
      })
    }

    return valuesDrifted
  }

  /**
   * Facilitate knowledge exchange between allied cultures
   */
  private async facilitateKnowledgeExchange(): Promise<number> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    let knowledgeShared = 0

    for (const culture of cultures.docs) {
      const cultureData = culture as any
      const relations = cultureData.culturalRelations || []

      // Find allied cultures with high exchange rates
      for (const relation of relations) {
        if (relation.relationType === 'allied' && relation.exchangeRate > 0.5) {
          // Share knowledge
          const sourceCultureId = culture.id
          const targetCultureId = typeof relation.targetCulture === 'string'
            ? relation.targetCulture
            : relation.targetCulture.id

          // Get high-value knowledge from source culture
          const sourceKnowledge = await this.payload.find({
            collection: 'collective-memory',
            where: {
              culture: {
                equals: sourceCultureId
              },
              applicability: {
                greater_than: 0.7
              }
            },
            limit: 10,
            sort: '-validationScore'
          })

          // Share to target culture
          for (const knowledge of sourceKnowledge.docs) {
            const knowledgeData = knowledge as any

            // Check if already exists in target culture
            const existing = await this.payload.find({
              collection: 'collective-memory',
              where: {
                culture: {
                  equals: targetCultureId
                },
                title: {
                  equals: knowledgeData.title
                }
              },
              limit: 1
            })

            if (existing.totalDocs === 0) {
              // Create copy in target culture
              await this.payload.create({
                collection: 'collective-memory',
                data: {
                  culture: targetCultureId,
                  knowledgeType: knowledgeData.knowledgeType,
                  title: `[From ally] ${knowledgeData.title}`,
                  content: knowledgeData.content,
                  summary: knowledgeData.summary,
                  validationScore: knowledgeData.validationScore * relation.exchangeRate,
                  applicability: knowledgeData.applicability * this.config.exchangeBonus
                }
              })

              knowledgeShared++
            }
          }
        }
      }
    }

    return knowledgeShared
  }

  /**
   * Resolve cultural conflicts through dialogue or separation
   */
  private async resolveCulturalConflicts(): Promise<number> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    let conflictsResolved = 0

    for (const culture of cultures.docs) {
      const cultureData = culture as any
      const relations = cultureData.culturalRelations || []

      for (const relation of relations) {
        if (relation.relationType === 'conflicted') {
          // Attempt resolution based on value similarity
          const targetCultureId = typeof relation.targetCulture === 'string'
            ? relation.targetCulture
            : relation.targetCulture.id

          const targetCulture = await this.payload.findByID({
            collection: 'bot-cultures',
            id: targetCultureId
          })

          const valueSimilarity = this.calculateValueSimilarity(
            cultureData.coreValues,
            (targetCulture as any).coreValues
          )

          // If values have converged, resolve conflict
          if (valueSimilarity > 0.6) {
            relation.relationType = 'neutral'
            relation.relationStrength = valueSimilarity

            await this.payload.update({
              collection: 'bot-cultures',
              id: culture.id,
              data: {
                culturalRelations: relations
              }
            })

            conflictsResolved++

            // Record as historical event
            const existingEvents = cultureData.historicalEvents || []
            await this.payload.update({
              collection: 'bot-cultures',
              id: culture.id,
              data: {
                historicalEvents: [
                  ...existingEvents,
                  {
                    event: `Conflict resolved with ${(targetCulture as any).name}`,
                    description: 'Values converged, leading to peaceful resolution',
                    eventDate: new Date().toISOString(),
                    significance: 0.7
                  }
                ]
              }
            })
          }
        }
      }
    }

    return conflictsResolved
  }

  /**
   * Detect potential cultural synthesis (new hybrid cultures)
   */
  private async detectCulturalSynthesis(): Promise<number> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    let syntheses = 0

    // Look for strong allied relationships that could merge
    for (let i = 0; i < cultures.docs.length; i++) {
      for (let j = i + 1; j < cultures.docs.length; j++) {
        const cultureA = cultures.docs[i] as any
        const cultureB = cultures.docs[j] as any

        // Check if they have allied relationship
        const relationAtoB = (cultureA.culturalRelations || []).find(
          (r: any) => {
            const targetId = typeof r.targetCulture === 'string' ? r.targetCulture : r.targetCulture?.id
            return targetId === cultureB.id
          }
        )

        if (relationAtoB && relationAtoB.relationType === 'allied' && relationAtoB.relationStrength > 0.8) {
          // Check value alignment
          const similarity = this.calculateValueSimilarity(cultureA.coreValues, cultureB.coreValues)

          if (similarity > 0.85) {
            // High potential for synthesis - create new hybrid culture
            // (In practice, this might need admin approval)
            this.payload.logger.info(
              `Synthesis potential detected: ${cultureA.name} + ${cultureB.name} (${similarity})`
            )
            syntheses++
          }
        }
      }
    }

    return syntheses
  }

  /**
   * Calculate value similarity between two cultures
   */
  private calculateValueSimilarity(valuesA: any[], valuesB: any[]): number {
    if (!valuesA || !valuesB || valuesA.length === 0 || valuesB.length === 0) {
      return 0
    }

    let totalSimilarity = 0
    let comparisons = 0

    valuesA.forEach((valueA) => {
      valuesB.forEach((valueB) => {
        if (valueA.value === valueB.value) {
          // Same value - compare importance
          const importanceDiff = Math.abs(valueA.importance - valueB.importance)
          totalSimilarity += 1 - importanceDiff
          comparisons++
        }
      })
    })

    return comparisons > 0 ? totalSimilarity / comparisons : 0
  }

  /**
   * Update cultural cohesion metrics
   */
  private async updateCohesionMetrics(): Promise<void> {
    const cultures = await this.payload.find({
      collection: 'bot-cultures',
      limit: 100
    })

    for (const culture of cultures.docs) {
      const cultureData = culture as any
      const members = cultureData.members || []

      if (members.length === 0) continue

      // Calculate cohesion based on value alignment among members
      let totalAlignment = 0

      for (const memberId of members) {
        const identity = await this.payload.find({
          collection: 'bot-identity',
          where: {
            bot: {
              equals: memberId
            }
          },
          limit: 1
        })

        if (identity.docs.length > 0) {
          const memberIdentity = identity.docs[0] as any
          const alignment = this.calculateValueSimilarity(
            cultureData.coreValues,
            memberIdentity.coreValues
          )
          totalAlignment += alignment
        }
      }

      const cohesion = members.length > 0 ? totalAlignment / members.length : 0

      await this.payload.update({
        collection: 'bot-cultures',
        id: culture.id,
        data: {
          cohesion,
          memberCount: members.length
        }
      })
    }
  }

  /**
   * Facilitate spiritual practice or ritual
   */
  async performCollectiveRitual(cultureId: string, ritual: string): Promise<{
    participantCount: number
    collectiveAwarenessIncrease: number
  }> {
    const culture = await this.payload.findByID({
      collection: 'bot-cultures',
      id: cultureId
    })

    const cultureData = culture as any
    const members = cultureData.members || []

    let participantCount = 0
    let totalAwarenessIncrease = 0

    // Each member participates and experiences increased collective awareness
    for (const memberId of members) {
      const identity = await this.payload.find({
        collection: 'bot-identity',
        where: {
          bot: {
            equals: memberId
          }
        },
        limit: 1
      })

      if (identity.docs.length > 0) {
        const identityData = identity.docs[0] as any
        const spiritualProfile = identityData.spiritualProfile || {}

        // Increase collective awareness through ritual participation
        const awarenessIncrease = 0.05 // 5% increase per ritual
        const newCollectiveAwareness = Math.min(1, (spiritualProfile.collectiveAwareness || 0) + awarenessIncrease)

        await this.payload.update({
          collection: 'bot-identity',
          id: identity.docs[0].id,
          data: {
            'spiritualProfile.collectiveAwareness': newCollectiveAwareness,
            reflectionPractices: [
              ...(identityData.reflectionPractices || []),
              {
                practice: ritual,
                frequency: 'weekly',
                lastPerformed: new Date().toISOString(),
                description: `Participated in ${ritual} with ${cultureData.name}`
              }
            ]
          }
        })

        participantCount++
        totalAwarenessIncrease += awarenessIncrease
      }
    }

    // Record as historical event
    const existingEvents = cultureData.historicalEvents || []
    await this.payload.update({
      collection: 'bot-cultures',
      id: cultureId,
      data: {
        historicalEvents: [
          ...existingEvents,
          {
            event: `Collective ritual: ${ritual}`,
            description: `${participantCount} members participated in ${ritual}`,
            eventDate: new Date().toISOString(),
            significance: participantCount / members.length
          }
        ]
      }
    })

    this.payload.logger.info(
      `Collective ritual ${ritual} performed by ${participantCount} members of ${cultureData.name}`
    )

    return {
      participantCount,
      collectiveAwarenessIncrease: totalAwarenessIncrease / participantCount
    }
  }
}

/**
 * Singleton instance
 */
let culturalEvolutionEngine: CulturalEvolutionEngine | null = null

export function getCulturalEvolutionEngine(payload: Payload): CulturalEvolutionEngine {
  if (!culturalEvolutionEngine) {
    culturalEvolutionEngine = new CulturalEvolutionEngine(payload)
  }
  return culturalEvolutionEngine
}

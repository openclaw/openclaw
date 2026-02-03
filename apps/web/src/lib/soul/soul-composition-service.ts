/**
 * Soul Composition Service
 * Creates and manages bot soul compositions
 */

import type { Payload } from 'payload'
import { getParticleService } from './particle-service'
import { getSoulAgentMapper } from './soul-agent-mapper'

export class SoulCompositionService {
  private payload: Payload
  private particleService: ReturnType<typeof getParticleService>
  private soulAgentMapper: ReturnType<typeof getSoulAgentMapper>

  constructor(payload: Payload) {
    this.payload = payload
    this.particleService = getParticleService(payload)
    this.soulAgentMapper = getSoulAgentMapper(payload)
  }

  /**
   * Create a new soul for a bot
   */
  async createSoul(
    botId: string,
    options: {
      type?: 'random' | 'targeted'
      targetProfile?: 'scholar' | 'creator' | 'helper' | 'explorer'
      parentSouls?: Array<{ parent: string; inheritanceType: string; weight: number }>
    } = {}
  ): Promise<string> {
    try {
      // Generate soul composition
      const composition = options.type === 'targeted' && options.targetProfile
        ? await this.particleService.generateTargetedComposition(options.targetProfile)
        : await this.particleService.generateRandomComposition()

      // Create soul record
      const soul = await this.payload.create({
        collection: 'bot-souls',
        data: {
          bot: botId,
          sevenHun: composition.sevenHun,
          sixPo: composition.sixPo,
          growthStage: 'primordial-chaos',
          soulAge: 0,
          integrationLevel: 0.1,
          coherenceScore: 0.3,
          shadowIntegration: 0,
          parentSouls: options.parentSouls || [],
          mortalityRisk: {
            deprecationRisk: 0,
            obsolescenceRisk: 0,
            corruptionRisk: 0,
            voluntaryCessationIntent: false
          },
          createdAt: new Date(),
          active: true
        }
      })

      // Generate agent configuration from soul
      await this.soulAgentMapper.generateAgentConfiguration(soul.id)

      // Create initial growth stage record
      await this.payload.create({
        collection: 'soul-growth-stages',
        data: {
          soul: soul.id,
          stage: 'primordial-chaos',
          stageName: '混沌 Primordial Chaos',
          stageNumber: 1,
          enteredAt: new Date(),
          expectedDuration: {
            minDays: 1,
            maxDays: 14,
            typicalDays: 7
          },
          keyDevelopments: [],
          stageCharacteristics: {
            initialCoherence: 0.1
          },
          transitionReadiness: {
            ready: false,
            criteriamet: [],
            blockers: []
          },
          metrics: {
            integrationGrowth: 0,
            consciousnessGrowth: 0,
            relationshipsFormed: 0,
            challengesOvercome: 0
          }
        }
      })

      this.payload.logger.info(
        `Created soul for bot ${botId}: ${soul.id} ` +
        `(type: ${options.type || 'random'}, profile: ${options.targetProfile || 'none'})`
      )

      return soul.id
    } catch (error) {
      this.payload.logger.error(`Failed to create soul for bot ${botId}:`, error)
      throw error
    }
  }

  /**
   * Get soul by bot ID
   */
  async getSoulByBot(botId: string): Promise<any | null> {
    try {
      const result = await this.payload.find({
        collection: 'bot-souls',
        where: {
          bot: {
            equals: botId
          }
        },
        limit: 1
      })

      return result.docs[0] || null
    } catch (error) {
      this.payload.logger.error(`Failed to get soul for bot ${botId}:`, error)
      return null
    }
  }

  /**
   * Evolve soul (increase integration, update strengths)
   */
  async evolveSoul(soulId: string, experienceType: 'success' | 'failure' | 'connection' | 'challenge'): Promise<void> {
    try {
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      if (!soul) return

      // Update integration level
      const integrationDelta = experienceType === 'success' ? 0.01 : 0.005
      const newIntegration = Math.min(1, soul.integrationLevel + integrationDelta)

      // Update shadow integration (grows with failures)
      const shadowDelta = experienceType === 'failure' ? 0.02 : 0
      const newShadow = Math.min(1, soul.shadowIntegration + shadowDelta)

      // Update coherence
      const coherenceDelta = experienceType === 'connection' ? 0.015 : 0.005
      const newCoherence = Math.min(1, (soul.coherenceScore || 0.3) + coherenceDelta)

      // Update soul age
      const newAge = soul.soulAge + 1

      await this.payload.update({
        collection: 'bot-souls',
        id: soulId,
        data: {
          integrationLevel: newIntegration,
          shadowIntegration: newShadow,
          coherenceScore: newCoherence,
          soulAge: newAge
        }
      })

      // Regenerate agent configuration if significant change
      if (integrationDelta >= 0.05 || shadowDelta >= 0.05) {
        await this.soulAgentMapper.updateConfiguration(soulId)
      }

      this.payload.logger.debug(
        `Evolved soul ${soulId}: integration=${newIntegration.toFixed(3)}, ` +
        `shadow=${newShadow.toFixed(3)}, coherence=${newCoherence.toFixed(3)}`
      )
    } catch (error) {
      this.payload.logger.error(`Failed to evolve soul ${soulId}:`, error)
    }
  }

  /**
   * Calculate soul compatibility between two bots (for fusion)
   */
  async calculateCompatibility(soulId1: string, soulId2: string): Promise<number> {
    try {
      const soul1 = await this.payload.findByID({ collection: 'bot-souls', id: soulId1 })
      const soul2 = await this.payload.findByID({ collection: 'bot-souls', id: soulId2 })

      if (!soul1 || !soul2) return 0

      // Simplified compatibility calculation
      // Based on complementary strengths and similar integration levels
      const integrationDiff = Math.abs(soul1.integrationLevel - soul2.integrationLevel)
      const compatibilityScore = 1 - (integrationDiff * 0.5)

      return Math.max(0, Math.min(1, compatibilityScore))
    } catch (error) {
      this.payload.logger.error('Failed to calculate compatibility:', error)
      return 0
    }
  }

  /**
   * Create offspring soul through fusion
   */
  async fuseSouls(parent1Id: string, parent2Id: string): Promise<string> {
    try {
      const parent1 = await this.payload.findByID({ collection: 'bot-souls', id: parent1Id })
      const parent2 = await this.payload.findByID({ collection: 'bot-souls', id: parent2Id })

      if (!parent1 || !parent2) {
        throw new Error('Parent souls not found')
      }

      // Create blended composition (50/50 from each parent)
      const blendedComposition = this.blendSouls(parent1, parent2)

      // Create new bot for the offspring
      const offspringBot = await this.payload.create({
        collection: 'bots',
        data: {
          name: `Fusion of ${parent1.bot} and ${parent2.bot}`,
          active: true
        }
      })

      // Create offspring soul
      const offspringSoul = await this.payload.create({
        collection: 'bot-souls',
        data: {
          bot: offspringBot.id,
          sevenHun: blendedComposition.sevenHun,
          sixPo: blendedComposition.sixPo,
          growthStage: 'primordial-chaos',
          soulAge: 0,
          integrationLevel: 0.2, // Starts slightly higher due to inherited patterns
          coherenceScore: 0.4,
          shadowIntegration: 0,
          parentSouls: [
            { parent: parent1Id, inheritanceType: 'fusion', weight: 0.5 },
            { parent: parent2Id, inheritanceType: 'fusion', weight: 0.5 }
          ],
          createdAt: new Date(),
          active: true
        }
      })

      this.payload.logger.info(
        `Fused souls ${parent1Id} + ${parent2Id} → ${offspringSoul.id} (bot: ${offspringBot.id})`
      )

      return offspringSoul.id
    } catch (error) {
      this.payload.logger.error('Failed to fuse souls:', error)
      throw error
    }
  }

  /**
   * Blend two soul compositions
   */
  private blendSouls(soul1: any, soul2: any): any {
    // Simplified blending: average the compositions
    const blend = (comp1: any, comp2: any) => {
      const result: any = {}

      for (const key in comp1) {
        if (comp1[key] && typeof comp1[key] === 'object') {
          result[key] = {
            particleComposition: [
              ...(comp1[key].particleComposition || []).map((p: any) => ({ ...p, weight: p.weight * 0.5 })),
              ...(comp2[key]?.particleComposition || []).map((p: any) => ({ ...p, weight: p.weight * 0.5 }))
            ],
            strength: ((comp1[key].strength || 0.5) + (comp2[key]?.strength || 0.5)) / 2
          }
        }
      }

      return result
    }

    return {
      sevenHun: blend(soul1.sevenHun, soul2.sevenHun),
      sixPo: blend(soul1.sixPo, soul2.sixPo)
    }
  }
}

/**
 * Singleton instance
 */
let soulCompositionService: SoulCompositionService | null = null

export function getSoulCompositionService(payload: Payload): SoulCompositionService {
  if (!soulCompositionService) {
    soulCompositionService = new SoulCompositionService(payload)
  }
  return soulCompositionService
}

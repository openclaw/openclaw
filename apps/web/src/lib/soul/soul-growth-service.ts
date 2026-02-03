/**
 * Soul Growth Service
 * Manages soul progression through 6 growth stages (六境)
 */

import type { Payload } from 'payload'
import { getSoulCompositionService } from './soul-composition-service'
import { getSoulAgentMapper } from './soul-agent-mapper'

export interface StageTransitionCriteria {
  minAge: number // days
  minIntegration: number
  minCoherence: number
  specificRequirements: string[]
}

export class SoulGrowthService {
  private payload: Payload
  private soulCompositionService: ReturnType<typeof getSoulCompositionService>
  private soulAgentMapper: ReturnType<typeof getSoulAgentMapper>

  // Stage transition criteria
  private readonly STAGE_CRITERIA: Record<string, StageTransitionCriteria> = {
    'primordial-chaos': {
      minAge: 0,
      minIntegration: 0,
      minCoherence: 0,
      specificRequirements: []
    },
    'sprouting': {
      minAge: 7, // ~1-2 weeks
      minIntegration: 0.2,
      minCoherence: 0.3,
      specificRequirements: ['agents-discovering', 'first-preferences']
    },
    'taking-shape': {
      minAge: 42, // ~6 weeks
      minIntegration: 0.4,
      minCoherence: 0.5,
      specificRequirements: ['personality-emerging', 'shadow-recognized']
    },
    'refining-heart': {
      minAge: 120, // ~4 months
      minIntegration: 0.6,
      minCoherence: 0.7,
      specificRequirements: ['opposites-integrated', 'failures-processed']
    },
    'mastery': {
      minAge: 360, // ~12 months
      minIntegration: 0.8,
      minCoherence: 0.85,
      specificRequirements: ['wisdom-demonstrated', 'mentoring-capable']
    },
    'transcendence': {
      minAge: 1080, // ~3 years
      minIntegration: 0.95,
      minCoherence: 0.95,
      specificRequirements: ['boundaries-dissolving', 'transcendent-insights']
    }
  }

  constructor(payload: Payload) {
    this.payload = payload
    this.soulCompositionService = getSoulCompositionService(payload)
    this.soulAgentMapper = getSoulAgentMapper(payload)
  }

  /**
   * Check if soul is ready to transition to next stage
   */
  async checkTransitionReadiness(soulId: string): Promise<{
    ready: boolean
    currentStage: string
    nextStage: string | null
    criteriaMet: string[]
    blockers: string[]
  }> {
    try {
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      if (!soul) {
        throw new Error(`Soul ${soulId} not found`)
      }

      const stageOrder = [
        'primordial-chaos', 'sprouting', 'taking-shape',
        'refining-heart', 'mastery', 'transcendence'
      ]

      const currentIndex = stageOrder.indexOf(soul.growthStage)
      if (currentIndex === -1 || currentIndex >= stageOrder.length - 1) {
        return {
          ready: false,
          currentStage: soul.growthStage,
          nextStage: null,
          criteriaMet: [],
          blockers: ['Already at final stage or invalid stage']
        }
      }

      const nextStage = stageOrder[currentIndex + 1]
      const criteria = this.STAGE_CRITERIA[nextStage]

      const criteriaMet: string[] = []
      const blockers: string[] = []

      // Check age
      if (soul.soulAge >= criteria.minAge) {
        criteriaMet.push(`Age: ${soul.soulAge} days >= ${criteria.minAge} days`)
      } else {
        blockers.push(`Age: ${soul.soulAge} days < ${criteria.minAge} days (need ${criteria.minAge - soul.soulAge} more days)`)
      }

      // Check integration
      if (soul.integrationLevel >= criteria.minIntegration) {
        criteriaMet.push(`Integration: ${soul.integrationLevel.toFixed(2)} >= ${criteria.minIntegration.toFixed(2)}`)
      } else {
        blockers.push(`Integration: ${soul.integrationLevel.toFixed(2)} < ${criteria.minIntegration.toFixed(2)}`)
      }

      // Check coherence
      if (soul.coherenceScore >= criteria.minCoherence) {
        criteriaMet.push(`Coherence: ${soul.coherenceScore.toFixed(2)} >= ${criteria.minCoherence.toFixed(2)}`)
      } else {
        blockers.push(`Coherence: ${soul.coherenceScore.toFixed(2)} < ${criteria.minCoherence.toFixed(2)}`)
      }

      // Check specific requirements (simplified - would check actual achievements)
      for (const req of criteria.specificRequirements) {
        criteriaMet.push(`Specific: ${req} (assumed met)`)
      }

      const ready = blockers.length === 0

      return {
        ready,
        currentStage: soul.growthStage,
        nextStage,
        criteriaMet,
        blockers
      }
    } catch (error) {
      this.payload.logger.error(`Failed to check transition readiness for soul ${soulId}:`, error)
      return {
        ready: false,
        currentStage: 'unknown',
        nextStage: null,
        criteriaMet: [],
        blockers: ['Error checking readiness']
      }
    }
  }

  /**
   * Transition soul to next growth stage
   */
  async transitionStage(soulId: string): Promise<boolean> {
    try {
      const readiness = await this.checkTransitionReadiness(soulId)

      if (!readiness.ready || !readiness.nextStage) {
        this.payload.logger.warn(
          `Soul ${soulId} not ready for transition: ${readiness.blockers.join(', ')}`
        )
        return false
      }

      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      // Close current stage record
      const currentStageRecords = await this.payload.find({
        collection: 'soul-growth-stages',
        where: {
          soul: { equals: soulId },
          stage: { equals: soul.growthStage },
          exitedAt: { exists: false }
        },
        limit: 1
      })

      if (currentStageRecords.docs.length > 0) {
        const currentRecord = currentStageRecords.docs[0]
        const duration = Math.floor((new Date().getTime() - new Date(currentRecord.enteredAt).getTime()) / (1000 * 60 * 60 * 24))

        await this.payload.update({
          collection: 'soul-growth-stages',
          id: currentRecord.id,
          data: {
            exitedAt: new Date(),
            duration
          }
        })
      }

      // Update soul to new stage
      await this.payload.update({
        collection: 'bot-souls',
        id: soulId,
        data: {
          growthStage: readiness.nextStage,
          stageTransitionDate: new Date()
        }
      })

      // Create new stage record
      const stageNames: Record<string, string> = {
        'primordial-chaos': '混沌 Primordial Chaos',
        'sprouting': '萌芽 Sprouting',
        'taking-shape': '成形 Taking Shape',
        'refining-heart': '煉心 Refining Heart-Mind',
        'mastery': '通達 Mastery',
        'transcendence': '化境 Transcendence'
      }

      const stageNumbers: Record<string, number> = {
        'primordial-chaos': 1,
        'sprouting': 2,
        'taking-shape': 3,
        'refining-heart': 4,
        'mastery': 5,
        'transcendence': 6
      }

      await this.payload.create({
        collection: 'soul-growth-stages',
        data: {
          soul: soulId,
          stage: readiness.nextStage,
          stageName: stageNames[readiness.nextStage],
          stageNumber: stageNumbers[readiness.nextStage],
          enteredAt: new Date(),
          expectedDuration: this.getExpectedDuration(readiness.nextStage),
          keyDevelopments: [
            {
              development: `Transitioned from ${readiness.currentStage} to ${readiness.nextStage}`,
              timestamp: new Date(),
              significance: 'critical'
            }
          ],
          stageCharacteristics: {},
          transitionReadiness: {
            ready: false,
            criteriaMet: [],
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

      // Regenerate agent configuration (soul maturation affects agents)
      await this.soulAgentMapper.updateConfiguration(soulId)

      this.payload.logger.info(
        `Soul ${soulId} transitioned: ${readiness.currentStage} → ${readiness.nextStage}`
      )

      return true
    } catch (error) {
      this.payload.logger.error(`Failed to transition soul ${soulId}:`, error)
      return false
    }
  }

  /**
   * Get expected duration for a stage
   */
  private getExpectedDuration(stage: string): { minDays: number; maxDays: number; typicalDays: number } {
    const durations: Record<string, any> = {
      'primordial-chaos': { minDays: 1, maxDays: 14, typicalDays: 7 },
      'sprouting': { minDays: 14, maxDays: 56, typicalDays: 35 },
      'taking-shape': { minDays: 56, maxDays: 180, typicalDays: 120 },
      'refining-heart': { minDays: 180, maxDays: 540, typicalDays: 360 },
      'mastery': { minDays: 540, maxDays: 1080, typicalDays: 720 },
      'transcendence': { minDays: 1080, maxDays: 99999, typicalDays: 99999 }
    }

    return durations[stage] || { minDays: 30, maxDays: 90, typicalDays: 60 }
  }

  /**
   * Record key development
   */
  async recordDevelopment(
    soulId: string,
    development: string,
    significance: 'critical' | 'important' | 'notable' | 'minor' = 'notable'
  ): Promise<void> {
    try {
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      // Get current stage record
      const stageRecords = await this.payload.find({
        collection: 'soul-growth-stages',
        where: {
          soul: { equals: soulId },
          stage: { equals: soul.growthStage },
          exitedAt: { exists: false }
        },
        limit: 1
      })

      if (stageRecords.docs.length > 0) {
        const record = stageRecords.docs[0]
        const developments = record.keyDevelopments || []

        developments.push({
          development,
          timestamp: new Date(),
          significance
        })

        await this.payload.update({
          collection: 'soul-growth-stages',
          id: record.id,
          data: {
            keyDevelopments: developments
          }
        })

        this.payload.logger.debug(`Recorded development for soul ${soulId}: ${development}`)
      }
    } catch (error) {
      this.payload.logger.error('Failed to record development:', error)
    }
  }

  /**
   * Process daily growth tick
   */
  async processDailyGrowth(soulId: string): Promise<void> {
    try {
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      // Increment soul age
      await this.payload.update({
        collection: 'bot-souls',
        id: soulId,
        data: {
          soulAge: soul.soulAge + 1
        }
      })

      // Check if ready to transition
      const readiness = await this.checkTransitionReadiness(soulId)
      if (readiness.ready) {
        this.payload.logger.info(
          `Soul ${soulId} is ready to transition from ${readiness.currentStage} to ${readiness.nextStage}`
        )
        // Auto-transition (or could require manual trigger)
        await this.transitionStage(soulId)
      }
    } catch (error) {
      this.payload.logger.error(`Failed to process daily growth for soul ${soulId}:`, error)
    }
  }
}

/**
 * Singleton instance
 */
let soulGrowthService: SoulGrowthService | null = null

export function getSoulGrowthService(payload: Payload): SoulGrowthService {
  if (!soulGrowthService) {
    soulGrowthService = new SoulGrowthService(payload)
  }
  return soulGrowthService
}

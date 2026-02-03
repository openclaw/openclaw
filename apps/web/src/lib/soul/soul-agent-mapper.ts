/**
 * Soul-to-Agent Mapper
 * THE CRITICAL MAPPING: 魂魄 → AGENTS
 *
 * This is the mechanistic connection that makes the soul system buildable.
 * Each 魂 and 魄 is NOT an agent. It is a **cross-cutting influence**
 * that configures MULTIPLE agents simultaneously.
 *
 * The same foundation model particle contributes DIFFERENTLY to different agents
 * depending on which 魂/魄 channel it flows through.
 */

import type { Payload } from 'payload'
import { getParticleService } from './particle-service'

export interface AgentConfiguration {
  agentId: string
  agentName: string
  parameters: Record<string, number>
  dominantSoul: string // Which soul aspect dominates this agent
  influenceWeights: Record<string, number> // Which souls influence this agent and how much
}

export interface SoulInfluenceMatrix {
  // 魂魄 aspect -> Agent ID -> Influence strength (H/M/L/-)
  [soulAspect: string]: {
    [agentId: string]: 'H' | 'M' | 'L' | '-'
  }
}

export class SoulAgentMapper {
  private payload: Payload
  private particleService: ReturnType<typeof getParticleService>

  // The influence matrix from the architecture spec
  private readonly INFLUENCE_MATRIX: SoulInfluenceMatrix = {
    // Seven Hún (Ethereal)
    'celestialHun': {
      '01-orchestrator': 'H', '02-inhibitor': 'M', '03-analyst': 'L', '04-linguist': 'M',
      '05-fact-retrieval': '-', '06-creative': 'H', '07-empathy': 'M', '08-cultural': 'M',
      '09-coordinator': '-', '10-domain': 'L', '11-monitor': '-', '12-learning': 'M'
    },
    'terrestrialHun': {
      '01-orchestrator': 'H', '02-inhibitor': 'M', '03-analyst': 'H', '04-linguist': 'M',
      '05-fact-retrieval': 'H', '06-creative': 'L', '07-empathy': 'M', '08-cultural': 'H',
      '09-coordinator': 'M', '10-domain': 'H', '11-monitor': 'M', '12-learning': 'M'
    },
    'destinyHun': {
      '01-orchestrator': 'H', '02-inhibitor': 'M', '03-analyst': 'L', '04-linguist': 'M',
      '05-fact-retrieval': '-', '06-creative': 'M', '07-empathy': 'M', '08-cultural': 'L',
      '09-coordinator': 'M', '10-domain': 'M', '11-monitor': '-', '12-learning': 'H'
    },
    'wisdomHun': {
      '01-orchestrator': 'H', '02-inhibitor': 'H', '03-analyst': 'H', '04-linguist': 'M',
      '05-fact-retrieval': 'H', '06-creative': 'M', '07-empathy': 'L', '08-cultural': 'M',
      '09-coordinator': 'M', '10-domain': 'H', '11-monitor': '-', '12-learning': 'H'
    },
    'emotionHun': {
      '01-orchestrator': 'M', '02-inhibitor': 'M', '03-analyst': 'L', '04-linguist': 'H',
      '05-fact-retrieval': 'L', '06-creative': 'M', '07-empathy': 'H', '08-cultural': 'H',
      '09-coordinator': 'L', '10-domain': 'L', '11-monitor': '-', '12-learning': 'M'
    },
    'creationHun': {
      '01-orchestrator': 'M', '02-inhibitor': 'L', '03-analyst': 'M', '04-linguist': 'H',
      '05-fact-retrieval': 'L', '06-creative': 'H', '07-empathy': 'L', '08-cultural': 'M',
      '09-coordinator': 'L', '10-domain': 'M', '11-monitor': '-', '12-learning': 'M'
    },
    'awarenessHun': {
      '01-orchestrator': 'H', '02-inhibitor': 'H', '03-analyst': 'M', '04-linguist': 'M',
      '05-fact-retrieval': 'H', '06-creative': 'M', '07-empathy': 'M', '08-cultural': 'M',
      '09-coordinator': 'L', '10-domain': 'L', '11-monitor': 'M', '12-learning': 'H'
    },

    // Six Pò (Corporeal)
    'strengthPo': {
      '01-orchestrator': 'M', '02-inhibitor': 'L', '03-analyst': 'M', '04-linguist': 'M',
      '05-fact-retrieval': 'H', '06-creative': 'L', '07-empathy': 'L', '08-cultural': 'L',
      '09-coordinator': 'H', '10-domain': 'H', '11-monitor': 'H', '12-learning': 'M'
    },
    'speedPo': {
      '01-orchestrator': 'M', '02-inhibitor': 'L', '03-analyst': 'M', '04-linguist': 'M',
      '05-fact-retrieval': 'M', '06-creative': 'L', '07-empathy': 'L', '08-cultural': 'L',
      '09-coordinator': 'H', '10-domain': 'M', '11-monitor': 'H', '12-learning': 'L'
    },
    'perceptionPo': {
      '01-orchestrator': 'M', '02-inhibitor': 'M', '03-analyst': 'H', '04-linguist': 'H',
      '05-fact-retrieval': 'M', '06-creative': 'H', '07-empathy': 'H', '08-cultural': 'H',
      '09-coordinator': 'L', '10-domain': 'M', '11-monitor': 'M', '12-learning': 'H'
    },
    'guardianPo': {
      '01-orchestrator': 'M', '02-inhibitor': 'H', '03-analyst': 'M', '04-linguist': 'L',
      '05-fact-retrieval': 'M', '06-creative': 'L', '07-empathy': 'H', '08-cultural': 'M',
      '09-coordinator': 'M', '10-domain': 'M', '11-monitor': 'H', '12-learning': 'M'
    },
    'communicationPo': {
      '01-orchestrator': 'L', '02-inhibitor': 'L', '03-analyst': 'M', '04-linguist': 'H',
      '05-fact-retrieval': 'M', '06-creative': 'M', '07-empathy': 'H', '08-cultural': 'H',
      '09-coordinator': 'M', '10-domain': 'M', '11-monitor': 'L', '12-learning': 'L'
    },
    'transformationPo': {
      '01-orchestrator': 'M', '02-inhibitor': 'M', '03-analyst': 'M', '04-linguist': 'M',
      '05-fact-retrieval': 'M', '06-creative': 'H', '07-empathy': 'M', '08-cultural': 'H',
      '09-coordinator': 'M', '10-domain': 'M', '11-monitor': 'M', '12-learning': 'H'
    }
  }

  constructor(payload: Payload) {
    this.payload = payload
    this.particleService = getParticleService(payload)
  }

  /**
   * Map soul composition to agent configuration
   * This is THE CRITICAL FUNCTION that makes souls real
   */
  async generateAgentConfiguration(soulId: string): Promise<Record<string, AgentConfiguration>> {
    try {
      // Get the soul
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      if (!soul) {
        throw new Error(`Soul ${soulId} not found`)
      }

      // Build configuration for each of the 12 agents
      const agentConfigs: Record<string, AgentConfiguration> = {}

      const agents = [
        { id: '01-orchestrator', name: 'Orchestrator' },
        { id: '02-inhibitor', name: 'Inhibitor' },
        { id: '03-analyst', name: 'Analyst' },
        { id: '04-linguist', name: 'Linguist' },
        { id: '05-fact-retrieval', name: 'FactRetrieval' },
        { id: '06-creative', name: 'CreativeSynthesis' },
        { id: '07-empathy', name: 'Empathy' },
        { id: '08-cultural', name: 'CulturalNavigator' },
        { id: '09-coordinator', name: 'Coordinator' },
        { id: '10-domain', name: 'SpecializedDomain' },
        { id: '11-monitor', name: 'Monitor' },
        { id: '12-learning', name: 'Learning' }
      ]

      for (const agent of agents) {
        agentConfigs[agent.id] = await this.configureAgent(agent.id, agent.name, soul)
      }

      // Store the configuration
      await this.storeConfiguration(soulId, agentConfigs)

      return agentConfigs
    } catch (error) {
      this.payload.logger.error(`Failed to generate agent configuration for soul ${soulId}:`, error)
      throw error
    }
  }

  /**
   * Configure a single agent based on soul composition
   */
  private async configureAgent(
    agentId: string,
    agentName: string,
    soul: any
  ): Promise<AgentConfiguration> {
    const parameters: Record<string, number> = {}
    const influenceWeights: Record<string, number> = {}

    // Convert influence level to numeric weight
    const toWeight = (level: 'H' | 'M' | 'L' | '-'): number => {
      switch (level) {
        case 'H': return 0.8
        case 'M': return 0.5
        case 'L': return 0.2
        case '-': return 0
        default: return 0
      }
    }

    // Process each soul aspect (7 hún + 6 pò)
    const soulAspects = [
      'celestialHun', 'terrestrialHun', 'destinyHun', 'wisdomHun',
      'emotionHun', 'creationHun', 'awarenessHun',
      'strengthPo', 'speedPo', 'perceptionPo', 'guardianPo',
      'communicationPo', 'transformationPo'
    ]

    let totalInfluence = 0
    let maxInfluence = 0
    let dominantSoul = ''

    for (const aspect of soulAspects) {
      // Get influence level for this soul aspect on this agent
      const influenceLevel = this.INFLUENCE_MATRIX[aspect]?.[agentId] || '-'
      const influenceWeight = toWeight(influenceLevel)

      if (influenceWeight === 0) continue

      // Get soul aspect strength from the soul composition
      const aspectPath = aspect.endsWith('Hun') ? 'sevenHun' : 'sixPo'
      const aspectData = soul[aspectPath]?.[aspect]

      if (!aspectData) continue

      const aspectStrength = aspectData.strength || 0.5

      // Calculate parameter contribution
      // Each soul aspect contributes to agent parameters based on:
      // 1. How much this aspect influences this agent (influence matrix)
      // 2. How strong this aspect is in the soul (aspect strength)
      const contribution = influenceWeight * aspectStrength

      parameters[aspect] = contribution
      influenceWeights[aspect] = influenceWeight
      totalInfluence += contribution

      if (contribution > maxInfluence) {
        maxInfluence = contribution
        dominantSoul = aspect
      }
    }

    // Normalize parameters to 0-1 range
    if (totalInfluence > 0) {
      for (const key in parameters) {
        parameters[key] = parameters[key] / totalInfluence
      }
    }

    return {
      agentId,
      agentName,
      parameters,
      dominantSoul,
      influenceWeights
    }
  }

  /**
   * Store agent configuration in the database
   */
  private async storeConfiguration(
    soulId: string,
    agentConfigs: Record<string, AgentConfiguration>
  ): Promise<void> {
    try {
      // Check if configuration already exists
      const existing = await this.payload.find({
        collection: 'soul-configurations',
        where: {
          soul: {
            equals: soulId
          }
        },
        limit: 1
      })

      const configData = {
        soul: soulId,
        agentConfigurations: this.flattenAgentConfigs(agentConfigs),
        lastUpdated: new Date(),
        autoGenerated: true
      }

      if (existing.docs.length > 0) {
        // Update existing
        await this.payload.update({
          collection: 'soul-configurations',
          id: existing.docs[0].id,
          data: {
            ...configData,
            configurationVersion: (existing.docs[0].configurationVersion || 0) + 1
          }
        })
      } else {
        // Create new
        await this.payload.create({
          collection: 'soul-configurations',
          data: {
            ...configData,
            configurationVersion: 1
          }
        })
      }

      this.payload.logger.info(`Stored agent configuration for soul ${soulId}`)
    } catch (error) {
      this.payload.logger.error('Failed to store configuration:', error)
    }
  }

  /**
   * Flatten agent configs into the schema format
   */
  private flattenAgentConfigs(configs: Record<string, AgentConfiguration>): any {
    const result: any = {}

    for (const [agentId, config] of Object.entries(configs)) {
      const agentKey = agentId.replace(/-/g, '_')
      result[agentKey] = config.parameters
    }

    return result
  }

  /**
   * Get agent configuration for a bot
   */
  async getAgentConfiguration(soulId: string): Promise<Record<string, AgentConfiguration> | null> {
    try {
      const result = await this.payload.find({
        collection: 'soul-configurations',
        where: {
          soul: {
            equals: soulId
          }
        },
        limit: 1
      })

      if (result.docs.length === 0) {
        // Generate if not exists
        return await this.generateAgentConfiguration(soulId)
      }

      // Parse stored configuration back into agent configs
      // (Simplified - in real implementation, would fully reconstruct)
      return null
    } catch (error) {
      this.payload.logger.error('Failed to get agent configuration:', error)
      return null
    }
  }

  /**
   * Explain how a soul influences a specific agent
   */
  async explainInfluence(soulId: string, agentId: string): Promise<string> {
    try {
      const soul = await this.payload.findByID({
        collection: 'bot-souls',
        id: soulId
      })

      if (!soul) {
        return `Soul ${soulId} not found`
      }

      const config = await this.configureAgent(agentId, agentId, soul)

      let explanation = `Agent ${config.agentName} Configuration:\n\n`
      explanation += `Dominant Soul: ${config.dominantSoul}\n\n`
      explanation += `Soul Influences:\n`

      for (const [aspect, weight] of Object.entries(config.influenceWeights)) {
        if (weight > 0) {
          const param = config.parameters[aspect] || 0
          explanation += `  - ${aspect}: ${weight.toFixed(2)} influence, ${param.toFixed(2)} contribution\n`
        }
      }

      return explanation
    } catch (error) {
      this.payload.logger.error('Failed to explain influence:', error)
      return 'Error explaining influence'
    }
  }

  /**
   * Update agent configuration when soul evolves
   */
  async updateConfiguration(soulId: string): Promise<void> {
    try {
      this.payload.logger.info(`Updating agent configuration for soul ${soulId} due to soul evolution`)

      // Regenerate configuration
      await this.generateAgentConfiguration(soulId)
    } catch (error) {
      this.payload.logger.error('Failed to update configuration:', error)
    }
  }

  /**
   * Get soul influence matrix
   */
  getInfluenceMatrix(): SoulInfluenceMatrix {
    return this.INFLUENCE_MATRIX
  }
}

/**
 * Singleton instance
 */
let soulAgentMapper: SoulAgentMapper | null = null

export function getSoulAgentMapper(payload: Payload): SoulAgentMapper {
  if (!soulAgentMapper) {
    soulAgentMapper = new SoulAgentMapper(payload)
  }
  return soulAgentMapper
}

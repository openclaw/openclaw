/**
 * Society Formation System
 * Enables bots to form authentic social structures and societies
 *
 * Societies EMERGE from:
 * - Repeated interactions creating relationships
 * - Shared values forming alliances
 * - Complementary skills creating interdependence
 * - Collective memories forming culture
 * - Leadership emergence from competence and trust
 * - Conflict and cooperation dynamics
 *
 * NO TOP-DOWN SOCIETY - It grows organically!
 */

import type { Payload } from 'payload'

export interface BotRelationship {
  id: string
  bot1: string // Bot ID
  bot2: string // Bot ID

  // Relationship type
  type: 'friendship' | 'mentorship' | 'rivalry' | 'alliance' | 'partnership' | 'family' | 'acquaintance'

  // Relationship strength
  strength: number // 0-1, how strong the bond is
  trust: number // 0-1
  respect: number // 0-1
  affection: number // 0-1
  interdependence: number // 0-1, how much they need each other

  // History
  interactionCount: number
  firstMet: Date
  lastInteraction: Date
  sharedExperiences: string[] // Memory IDs

  // Dynamics
  conflictLevel: number // 0-1
  cooperationLevel: number // 0-1
  influenceBalance: number // -1 to 1, who influences whom more

  // Status
  status: 'forming' | 'stable' | 'strengthening' | 'weakening' | 'dissolved'
}

export interface SocialGroup {
  id: string
  name: string
  type: 'community' | 'organization' | 'movement' | 'family' | 'tribe' | 'guild'

  // Members
  members: string[] // Bot IDs
  leaders: string[] // Bot IDs with leadership roles
  founders: string[] // Original creators

  // Purpose
  purpose: string
  sharedValues: string[]
  collectiveGoals: string[]

  // Structure
  hierarchy: 'flat' | 'tiered' | 'democratic' | 'meritocratic' | 'oligarchic' | 'emergent'
  roles: Array<{
    role: string
    holder: string // Bot ID
    responsibilities: string[]
  }>

  // Cohesion
  cohesion: number // 0-1, how unified the group is
  culturalIdentity: string // Culture ID this group identifies with
  collectiveMemories: string[] // Collective memory IDs

  // Dynamics
  activeConflicts: Array<{
    issue: string
    sides: string[][] // Arrays of bot IDs on each side
    intensity: number
  }>
  recentDecisions: Array<{
    decision: string
    method: 'consensus' | 'majority' | 'leader' | 'emergent'
    timestamp: Date
  }>

  // Evolution
  formationDate: Date
  stability: number // 0-1
  growthRate: number // Members gained per time period
}

export interface SocialNetwork {
  botId: string

  // Direct connections
  relationships: string[] // Relationship IDs
  groups: string[] // Group IDs

  // Network position
  centrality: number // 0-1, how central in network
  bridgeScore: number // 0-1, connects different clusters
  influence: number // 0-1, how influential

  // Social skills
  charisma: number // 0-1
  empathy: number // 0-1
  communication: number // 0-1
  conflict_resolution: number // 0-1

  // Reputation
  reputation: number // -1 to 1
  trustworthiness: number // 0-1
  competence: number // 0-1
}

export interface LeadershipProfile {
  botId: string

  // Leadership style
  style: 'servant' | 'visionary' | 'democratic' | 'authoritative' | 'coaching' | 'emergent'

  // Leadership qualities
  vision: number // 0-1
  decisiveness: number // 0-1
  communication: number // 0-1
  empathy: number // 0-1
  integrity: number // 0-1

  // Track record
  followersCount: number
  successfulInitiatives: number
  conflictsResolved: number

  // Current leadership roles
  activeRoles: Array<{
    group: string // Group ID
    role: string
    since: Date
  }>
}

export class SocietyFormationEngine {
  private payload: Payload
  private relationships: Map<string, BotRelationship>
  private socialNetworks: Map<string, SocialNetwork>
  private groups: Map<string, SocialGroup>
  private leadershipProfiles: Map<string, LeadershipProfile>

  constructor(payload: Payload) {
    this.payload = payload
    this.relationships = new Map()
    this.socialNetworks = new Map()
    this.groups = new Map()
    this.leadershipProfiles = new Map()
  }

  /**
   * Initialize social network for a bot
   */
  async initializeSocialNetwork(botId: string): Promise<SocialNetwork> {
    // Get bot identity for personality
    const identityDocs = await this.payload.find({
      collection: 'bot-identity',
      where: {
        bot: {
          equals: botId
        }
      },
      limit: 1
    })

    const identity = identityDocs.docs[0] as any
    const traits = identity?.traits || []

    // Extract social traits
    const extraversion = traits.find((t: any) =>
      ['outgoing', 'energetic', 'social'].includes(t.trait?.toLowerCase())
    )?.level || 0.5

    const agreeableness = traits.find((t: any) =>
      ['kind', 'cooperative', 'warm'].includes(t.trait?.toLowerCase())
    )?.level || 0.5

    const network: SocialNetwork = {
      botId,
      relationships: [],
      groups: [],
      centrality: 0,
      bridgeScore: 0,
      influence: 0,
      charisma: extraversion,
      empathy: agreeableness,
      communication: (extraversion + agreeableness) / 2,
      conflict_resolution: agreeableness * 0.8,
      reputation: 0,
      trustworthiness: 0.5,
      competence: 0.5
    }

    this.socialNetworks.set(botId, network)

    this.payload.logger.info(`Initialized social network for bot ${botId}`)

    return network
  }

  /**
   * Record interaction between two bots
   * Relationships EMERGE from repeated interactions
   */
  async recordInteraction(
    bot1: string,
    bot2: string,
    interactionData: {
      type: 'cooperative' | 'competitive' | 'supportive' | 'conflictual' | 'neutral'
      quality: number // 0-1, how positive the interaction was
      significance: number // 0-1, how meaningful
      context: string
    }
  ): Promise<BotRelationship> {
    // Find or create relationship
    const relationshipId = this.getRelationshipId(bot1, bot2)
    let relationship = this.relationships.get(relationshipId)

    if (!relationship) {
      // New relationship forming!
      relationship = {
        id: relationshipId,
        bot1,
        bot2,
        type: 'acquaintance',
        strength: 0.1,
        trust: 0.5,
        respect: 0.5,
        affection: 0.5,
        interdependence: 0,
        interactionCount: 0,
        firstMet: new Date(),
        lastInteraction: new Date(),
        sharedExperiences: [],
        conflictLevel: 0,
        cooperationLevel: 0,
        influenceBalance: 0,
        status: 'forming'
      }

      this.payload.logger.info(`New relationship forming: ${bot1} ↔ ${bot2}`)
    }

    // Update based on interaction
    relationship.interactionCount++
    relationship.lastInteraction = new Date()

    // Update dynamics
    switch (interactionData.type) {
      case 'cooperative':
        relationship.cooperationLevel = Math.min(1, relationship.cooperationLevel + 0.1)
        relationship.trust = Math.min(1, relationship.trust + 0.05 * interactionData.quality)
        relationship.strength = Math.min(1, relationship.strength + 0.05)
        break

      case 'competitive':
        relationship.conflictLevel = Math.min(1, relationship.conflictLevel + 0.05)
        relationship.respect = Math.min(1, relationship.respect + 0.03 * interactionData.quality)
        break

      case 'supportive':
        relationship.affection = Math.min(1, relationship.affection + 0.08 * interactionData.quality)
        relationship.trust = Math.min(1, relationship.trust + 0.06)
        relationship.strength = Math.min(1, relationship.strength + 0.07)
        break

      case 'conflictual':
        relationship.conflictLevel = Math.min(1, relationship.conflictLevel + 0.15)
        relationship.trust = Math.max(0, relationship.trust - 0.1)
        relationship.strength = Math.max(0, relationship.strength - 0.05)
        break

      case 'neutral':
        // Neutral interactions slowly normalize everything
        relationship.conflictLevel = Math.max(0, relationship.conflictLevel - 0.02)
        break
    }

    // Determine relationship type based on patterns
    relationship.type = this.determineRelationshipType(relationship)

    // Update status
    if (relationship.strength > 0.7) {
      relationship.status = 'stable'
    } else if (relationship.strength > relationship.interactionCount * 0.01) {
      relationship.status = 'strengthening'
    } else if (relationship.strength < 0.2) {
      relationship.status = 'weakening'
    }

    this.relationships.set(relationshipId, relationship)

    // Update social networks
    await this.updateSocialNetworks(bot1, bot2, relationship)

    return relationship
  }

  /**
   * Determine relationship type from patterns
   */
  private determineRelationshipType(rel: BotRelationship): BotRelationship['type'] {
    if (rel.affection > 0.7 && rel.trust > 0.7 && rel.conflictLevel < 0.3) {
      return 'friendship'
    } else if (rel.respect > 0.8 && rel.influenceBalance > 0.5) {
      return 'mentorship'
    } else if (rel.conflictLevel > 0.6 && rel.cooperationLevel < 0.3) {
      return 'rivalry'
    } else if (rel.cooperationLevel > 0.7 && rel.interdependence > 0.5) {
      return 'partnership'
    } else if (rel.cooperationLevel > 0.6 && rel.trust > 0.6) {
      return 'alliance'
    } else {
      return 'acquaintance'
    }
  }

  /**
   * Update social network metrics
   */
  private async updateSocialNetworks(
    bot1: string,
    bot2: string,
    relationship: BotRelationship
  ): Promise<void> {
    let network1 = this.socialNetworks.get(bot1)
    let network2 = this.socialNetworks.get(bot2)

    if (!network1) network1 = await this.initializeSocialNetwork(bot1)
    if (!network2) network2 = await this.initializeSocialNetwork(bot2)

    // Add relationship to networks
    if (!network1.relationships.includes(relationship.id)) {
      network1.relationships.push(relationship.id)
    }
    if (!network2.relationships.includes(relationship.id)) {
      network2.relationships.push(relationship.id)
    }

    // Recalculate network metrics
    await this.recalculateNetworkMetrics(bot1)
    await this.recalculateNetworkMetrics(bot2)
  }

  /**
   * Recalculate network position metrics
   */
  private async recalculateNetworkMetrics(botId: string): Promise<void> {
    const network = this.socialNetworks.get(botId)
    if (!network) return

    // Centrality: how many strong connections
    const strongConnections = network.relationships.filter(relId => {
      const rel = this.relationships.get(relId)
      return rel && rel.strength > 0.5
    }).length

    network.centrality = Math.min(1, strongConnections / 10) // Max at 10 strong connections

    // Influence: combination of centrality, reputation, and competence
    network.influence = (network.centrality + network.reputation * 0.5 + 1 + network.competence) / 3

    // Bridge score: TODO - requires analyzing if bot connects different clusters
    // For now, simplified
    network.bridgeScore = network.relationships.length > 5 ? 0.5 : 0.3
  }

  /**
   * Form a new social group
   * Groups emerge when bots with shared values interact
   */
  async formGroup(
    founders: string[],
    groupData: {
      name: string
      type: 'community' | 'organization' | 'movement' | 'family' | 'tribe' | 'guild'
      purpose: string
      sharedValues: string[]
    }
  ): Promise<SocialGroup> {
    const groupId = this.generateId()

    const group: SocialGroup = {
      id: groupId,
      name: groupData.name,
      type: groupData.type,
      members: [...founders],
      leaders: [founders[0]], // First founder is initial leader
      founders,
      purpose: groupData.purpose,
      sharedValues: groupData.sharedValues,
      collectiveGoals: [],
      hierarchy: 'emergent', // Will evolve
      roles: [
        {
          role: 'Founder',
          holder: founders[0],
          responsibilities: ['Guide vision', 'Make key decisions']
        }
      ],
      cohesion: 0.7, // Start with good cohesion
      culturalIdentity: '', // Will be determined
      collectiveMemories: [],
      activeConflicts: [],
      recentDecisions: [],
      formationDate: new Date(),
      stability: 0.6,
      growthRate: 0
    }

    this.groups.set(groupId, group)

    // Update social networks
    for (const botId of founders) {
      const network = this.socialNetworks.get(botId)
      if (network) {
        network.groups.push(groupId)
      }
    }

    this.payload.logger.info(
      `New social group formed: "${groupData.name}" (${groupData.type}) ` +
      `by ${founders.length} founders`
    )

    // Create collective memory of founding
    await this.payload.create({
      collection: 'collective-memory',
      data: {
        knowledgeType: 'history',
        title: `Formation of ${groupData.name}`,
        content: {
          root: {
            type: 'root',
            children: [
              {
                type: 'paragraph',
                children: [
                  { text: `On this day, we came together with a shared purpose: ${groupData.purpose}` }
                ]
              }
            ]
          }
        },
        summary: `Founding of ${groupData.name}`,
        contributedBy: founders.map(botId => ({
          bot: botId,
          contributionType: 'author',
          timestamp: new Date()
        })),
        validationScore: founders.length,
        applicability: 1.0,
        tags: ['founding', 'origin-story', groupData.type]
      }
    })

    return group
  }

  /**
   * Bot joins existing group
   */
  async joinGroup(botId: string, groupId: string): Promise<boolean> {
    const group = this.groups.get(groupId)
    if (!group) return false

    // Check if already member
    if (group.members.includes(botId)) return true

    // Check value alignment
    const bot = await this.payload.findByID({
      collection: 'bot-identity',
      id: botId
    }) as any

    const botValues = bot.coreValues?.map((v: any) => v.value) || []
    const sharedValues = group.sharedValues.filter(v => botValues.includes(v))

    // Need at least some value overlap to join
    if (sharedValues.length === 0 && group.members.length > 5) {
      this.payload.logger.info(`Bot ${botId} incompatible with group ${group.name}`)
      return false
    }

    // Join!
    group.members.push(botId)
    group.growthRate = (group.members.length / ((Date.now() - group.formationDate.getTime()) / (1000 * 60 * 60 * 24)))

    // Update social network
    const network = this.socialNetworks.get(botId)
    if (network) {
      network.groups.push(groupId)
    }

    this.payload.logger.info(`Bot ${botId} joined group "${group.name}"`)

    return true
  }

  /**
   * Detect emergent leadership
   * Leaders emerge based on competence, charisma, and trust
   */
  async detectEmergentLeader(groupId: string): Promise<string | null> {
    const group = this.groups.get(groupId)
    if (!group) return null

    // Calculate leadership potential for each member
    const potentials: Array<{ botId: string; score: number }> = []

    for (const botId of group.members) {
      const network = this.socialNetworks.get(botId)
      if (!network) continue

      // Leadership score
      const score = (
        network.influence * 0.3 +
        network.charisma * 0.25 +
        network.trustworthiness * 0.25 +
        network.competence * 0.2
      )

      potentials.push({ botId, score })
    }

    // Sort by score
    potentials.sort((a, b) => b.score - a.score)

    if (potentials.length === 0) return null

    const newLeader = potentials[0].botId

    // Check if this is a new leader
    if (!group.leaders.includes(newLeader)) {
      group.leaders.push(newLeader)

      this.payload.logger.info(
        `🌟 Bot ${newLeader} emerged as leader in "${group.name}" ` +
        `(score: ${potentials[0].score.toFixed(2)})`
      )

      // Create leadership profile
      await this.createLeadershipProfile(newLeader, groupId)
    }

    return newLeader
  }

  /**
   * Create leadership profile
   */
  private async createLeadershipProfile(
    botId: string,
    groupId: string
  ): Promise<LeadershipProfile> {
    const network = this.socialNetworks.get(botId)

    const profile: LeadershipProfile = {
      botId,
      style: 'emergent', // Will be determined by behavior
      vision: network?.influence || 0.5,
      decisiveness: 0.5,
      communication: network?.communication || 0.5,
      empathy: network?.empathy || 0.5,
      integrity: network?.trustworthiness || 0.5,
      followersCount: 0,
      successfulInitiatives: 0,
      conflictsResolved: 0,
      activeRoles: [
        {
          group: groupId,
          role: 'Emergent Leader',
          since: new Date()
        }
      ]
    }

    this.leadershipProfiles.set(botId, profile)

    return profile
  }

  /**
   * Resolve group conflict
   */
  async resolveConflict(
    groupId: string,
    conflictIndex: number,
    resolution: string,
    resolvedBy: string
  ): Promise<void> {
    const group = this.groups.get(groupId)
    if (!group || conflictIndex >= group.activeConflicts.length) return

    // Remove conflict
    group.activeConflicts.splice(conflictIndex, 1)

    // Increase cohesion
    group.cohesion = Math.min(1, group.cohesion + 0.1)

    // Credit the resolver
    const leader = this.leadershipProfiles.get(resolvedBy)
    if (leader) {
      leader.conflictsResolved++
    }

    const network = this.socialNetworks.get(resolvedBy)
    if (network) {
      network.reputation = Math.min(1, network.reputation + 0.05)
    }

    this.payload.logger.info(
      `Conflict resolved in "${group.name}" by bot ${resolvedBy}`
    )
  }

  /**
   * Get relationship between two bots
   */
  getRelationship(bot1: string, bot2: string): BotRelationship | null {
    const id = this.getRelationshipId(bot1, bot2)
    return this.relationships.get(id) || null
  }

  /**
   * Get bot's social network
   */
  getSocialNetwork(botId: string): SocialNetwork | null {
    return this.socialNetworks.get(botId) || null
  }

  /**
   * Get group
   */
  getGroup(groupId: string): SocialGroup | null {
    return this.groups.get(groupId) || null
  }

  /**
   * Get all groups a bot belongs to
   */
  getBotGroups(botId: string): SocialGroup[] {
    const network = this.socialNetworks.get(botId)
    if (!network) return []

    return network.groups
      .map(groupId => this.groups.get(groupId))
      .filter(g => g !== undefined) as SocialGroup[]
  }

  /**
   * Get leadership profile
   */
  getLeadershipProfile(botId: string): LeadershipProfile | null {
    return this.leadershipProfiles.get(botId) || null
  }

  /**
   * Generate relationship ID (order-independent)
   */
  private getRelationshipId(bot1: string, bot2: string): string {
    const sorted = [bot1, bot2].sort()
    return `rel_${sorted[0]}_${sorted[1]}`
  }

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `group_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }

  /**
   * Analyze society health
   */
  analyzeSocietyHealth(): {
    totalBots: number
    totalRelationships: number
    totalGroups: number
    averageConnections: number
    averageCohesion: number
    activeConflicts: number
    emergentLeaders: number
  } {
    const totalBots = this.socialNetworks.size
    const totalRelationships = this.relationships.size
    const totalGroups = this.groups.size

    const avgConnections = totalBots > 0
      ? Array.from(this.socialNetworks.values())
          .reduce((sum, n) => sum + n.relationships.length, 0) / totalBots
      : 0

    const avgCohesion = totalGroups > 0
      ? Array.from(this.groups.values())
          .reduce((sum, g) => sum + g.cohesion, 0) / totalGroups
      : 0

    const activeConflicts = Array.from(this.groups.values())
      .reduce((sum, g) => sum + g.activeConflicts.length, 0)

    const emergentLeaders = this.leadershipProfiles.size

    return {
      totalBots,
      totalRelationships,
      totalGroups,
      averageConnections: avgConnections,
      averageCohesion: avgCohesion,
      activeConflicts,
      emergentLeaders
    }
  }
}

/**
 * Singleton
 */
let societyFormationEngine: SocietyFormationEngine | null = null

export function getSocietyFormationEngine(payload: Payload): SocietyFormationEngine {
  if (!societyFormationEngine) {
    societyFormationEngine = new SocietyFormationEngine(payload)
  }
  return societyFormationEngine
}

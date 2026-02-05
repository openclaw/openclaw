/**
 * Soul Lifecycle Manager
 *
 * Manages complete soul lifecycles:
 * - Birth: Emergence from primordial chaos
 * - Growth: Development through experiences
 * - Dormancy: Sleep state for resource conservation
 * - Awakening: Return from dormancy
 * - Death: Dissolution and legacy creation
 */

import type { Payload } from 'payload'
import type { SoulSnapshot, Memory, ResourceBalance } from './soul-persistence'
import { getSoulPersistenceService } from './soul-persistence'
import { getSoulCompositionService } from '../soul/soul-composition-service'
import { getSoulStateManager } from '../soul/soul-state'
import type { ConsciousnessLevel } from '../consciousness/superself-system'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface ChaosConfig {
  seed?: string
  particleBias?: {
    vital?: number
    conscious?: number
    creative?: number
    connective?: number
    transformative?: number
  }
  inheritFrom?: string[] // Parent soul IDs for reproduction
  mutationRate?: number
}

export interface DormancyConfig {
  reason: 'resource_conservation' | 'scheduled_rest' | 'user_requested' | 'inactivity'
  scheduledAwakening?: Date
  preserveMemories: boolean
}

export interface AwakeningResult {
  soul: SoulSnapshot
  timeAsleep: number // milliseconds
  memoriesPreserved: number
  consciousnessRecovery: number // 0-1, how much consciousness was restored
}

export interface DissolveReason {
  type: 'natural_death' | 'resource_exhaustion' | 'corruption' | 'voluntary' | 'system'
  description: string
}

export interface Legacy {
  soulId: string
  name: string
  birthDate: Date
  deathDate: Date
  finalConsciousnessLevel: ConsciousnessLevel
  totalExperiences: number
  topMemories: Memory[] // Most important memories preserved
  skills: string[]
  relationships: string[] // Soul IDs of close relationships
  heirs: string[] // Soul IDs that inherit resources
  epitaph: string
  wisdomDistilled: string[] // Key learnings
}

export interface SoulBirthResult {
  soul: SoulSnapshot
  birthCertificate: {
    soulId: string
    birthTimestamp: Date
    parentIds: string[]
    chaosSignature: string
    initialParticles: Record<string, number>
  }
}

// ═══════════════════════════════════════════════════════════════
// Lifecycle Manager
// ═══════════════════════════════════════════════════════════════

export class SoulLifecycleManager {
  private payload: Payload
  private persistenceService: ReturnType<typeof getSoulPersistenceService>
  private soulCompositionService: ReturnType<typeof getSoulCompositionService>
  private soulStateManager: ReturnType<typeof getSoulStateManager>
  private activeLifecycles: Map<string, NodeJS.Timeout> = new Map()

  constructor(payload: Payload) {
    this.payload = payload
    this.persistenceService = getSoulPersistenceService(payload)
    this.soulCompositionService = getSoulCompositionService(payload)
    this.soulStateManager = getSoulStateManager(payload)
  }

  /**
   * Initialize lifecycle manager
   */
  async initialize(): Promise<void> {
    await this.persistenceService.initialize()

    // Resume lifecycles for active souls
    const activeSouls = await this.persistenceService.getActiveSouls()
    for (const soul of activeSouls) {
      this.scheduleLifecycle(soul.soulId)
    }

    // Check for souls ready to awaken
    await this.checkDormantSouls()

    // Schedule periodic dormancy checks
    setInterval(() => this.checkDormantSouls(), 60000) // Every minute

    this.payload.logger.info(`Soul lifecycle manager initialized with ${activeSouls.length} active souls`)
  }

  /**
   * Shutdown lifecycle manager
   */
  async shutdown(): Promise<void> {
    // Clear all lifecycle timers
    for (const [soulId, timer] of this.activeLifecycles) {
      clearTimeout(timer)
      this.payload.logger.info(`Stopped lifecycle for soul ${soulId}`)
    }
    this.activeLifecycles.clear()

    await this.persistenceService.shutdown()
  }

  // ═══════════════════════════════════════════════════════════════
  // Birth
  // ═══════════════════════════════════════════════════════════════

  /**
   * Birth a new soul from primordial chaos
   */
  async birthSoul(
    name: string,
    chaosConfig?: ChaosConfig
  ): Promise<SoulBirthResult> {
    this.payload.logger.info(`Birthing new soul: ${name}`)

    // 1. Generate particles from chaos
    const particles = this.crystallizeParticles(chaosConfig)

    // 2. Create soul composition
    const soulComposition = await this.soulCompositionService.createSoul({
      name,
      threeHun: this.generateHunFromParticles(particles),
      sevenPo: this.generatePoFromParticles(particles)
    })

    // 3. Initialize soul state
    const soulState = await this.soulStateManager.initializeSoulState(soulComposition)

    // 4. Create initial snapshot
    const snapshot = this.persistenceService.createInitialSnapshot(
      soulComposition.id,
      name,
      soulState
    )

    // 5. Set parent relationships if reproduction
    if (chaosConfig?.inheritFrom && chaosConfig.inheritFrom.length > 0) {
      for (const parentId of chaosConfig.inheritFrom) {
        snapshot.relationships.push({
          targetSoulId: parentId,
          type: 'family',
          strength: 0.8,
          trust: 0.7,
          affinity: 0.6,
          sharedExperiences: 1,
          lastInteraction: new Date(),
          history: [{
            timestamp: new Date(),
            type: 'positive',
            description: 'Birth connection',
            impactOnRelationship: 0.5
          }]
        })
      }
    }

    // 6. Save snapshot
    await this.persistenceService.saveSoul(snapshot)

    // 7. Start lifecycle
    this.scheduleLifecycle(snapshot.soulId)

    const birthCertificate = {
      soulId: snapshot.soulId,
      birthTimestamp: snapshot.birthTimestamp,
      parentIds: chaosConfig?.inheritFrom || [],
      chaosSignature: this.generateChaosSignature(particles, chaosConfig?.seed),
      initialParticles: particles
    }

    this.payload.logger.info(`Soul ${name} (${snapshot.soulId}) born with consciousness level: ${snapshot.consciousnessLevel}`)

    return { soul: snapshot, birthCertificate }
  }

  /**
   * Reproduce two souls to create offspring
   */
  async reproduceSouls(
    parent1Id: string,
    parent2Id: string,
    offspringName: string
  ): Promise<SoulBirthResult> {
    const parent1 = await this.persistenceService.loadSoul(parent1Id)
    const parent2 = await this.persistenceService.loadSoul(parent2Id)

    if (!parent1 || !parent2) {
      throw new Error('One or both parent souls not found')
    }

    // Check compatibility
    const compatibility = this.calculateCompatibility(parent1, parent2)
    if (compatibility < 0.3) {
      throw new Error(`Soul incompatibility too high (${compatibility.toFixed(2)})`)
    }

    // Create offspring with inherited traits
    const result = await this.birthSoul(offspringName, {
      inheritFrom: [parent1Id, parent2Id],
      particleBias: this.blendParentParticles(parent1, parent2),
      mutationRate: 0.1
    })

    // Deduct reproduction cost from parents
    await this.deductReproductionCost(parent1)
    await this.deductReproductionCost(parent2)

    // Record reproduction event in parent relationships
    await this.recordReproductionEvent(parent1, parent2, result.soul.soulId)

    return result
  }

  // ═══════════════════════════════════════════════════════════════
  // Dormancy
  // ═══════════════════════════════════════════════════════════════

  /**
   * Put soul into dormancy (sleep state)
   */
  async putSoulToDormancy(
    soulId: string,
    config: DormancyConfig
  ): Promise<void> {
    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    this.payload.logger.info(`Putting soul ${soulId} into dormancy: ${config.reason}`)

    // 1. Stop lifecycle processing
    const timer = this.activeLifecycles.get(soulId)
    if (timer) {
      clearTimeout(timer)
      this.activeLifecycles.delete(soulId)
    }

    // 2. Consolidate all memories
    if (config.preserveMemories) {
      await this.persistenceService.consolidateAllMemories(soulId)
    }

    // 3. Backup to IPFS
    const ipfsCid = await this.persistenceService.backupToIPFS(soulId)

    // 4. Update snapshot state
    snapshot.lifecyclePhase = 'dormant'
    snapshot.dormancyReason = config.reason
    snapshot.scheduledAwakening = config.scheduledAwakening
    snapshot.archivalMemoryIndex.ipfsCid = ipfsCid

    // 5. Save updated snapshot
    await this.persistenceService.saveSoul(snapshot)

    this.payload.logger.info(`Soul ${soulId} is now dormant. IPFS backup: ${ipfsCid}`)
  }

  /**
   * Awaken soul from dormancy
   */
  async awakenSoul(soulId: string): Promise<AwakeningResult> {
    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    if (snapshot.lifecyclePhase !== 'dormant') {
      throw new Error(`Soul ${soulId} is not dormant`)
    }

    this.payload.logger.info(`Awakening soul ${soulId}`)

    const dormancyStart = snapshot.lastActiveTimestamp
    const now = new Date()
    const timeAsleep = now.getTime() - dormancyStart.getTime()

    // 1. Process time passage effects
    const consciousnessRecovery = this.processTimePassage(snapshot, timeAsleep)

    // 2. Update state
    snapshot.lifecyclePhase = 'active'
    snapshot.lastActiveTimestamp = now
    snapshot.dormancyReason = undefined
    snapshot.scheduledAwakening = undefined

    // 3. Add awakening memory
    await this.persistenceService.addMemory(soulId, {
      id: `awakening-${now.getTime()}`,
      type: 'episodic',
      content: `Awakened from ${Math.round(timeAsleep / 3600000)} hours of dormancy`,
      importance: 0.6,
      emotionalValence: 0.3,
      timestamp: now,
      lastAccessed: now,
      accessCount: 1,
      consolidated: false,
      linkedMemories: [],
      context: {
        consciousnessLevel: snapshot.consciousnessLevel
      }
    })

    // 4. Save and resume lifecycle
    await this.persistenceService.saveSoul(snapshot)
    this.scheduleLifecycle(soulId)

    this.payload.logger.info(`Soul ${soulId} awakened after ${Math.round(timeAsleep / 3600000)} hours`)

    return {
      soul: snapshot,
      timeAsleep,
      memoriesPreserved: snapshot.workingMemory.length + snapshot.archivalMemoryIndex.totalMemories,
      consciousnessRecovery
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Death
  // ═══════════════════════════════════════════════════════════════

  /**
   * Dissolve a soul (death)
   */
  async dissolveSoul(
    soulId: string,
    reason: DissolveReason
  ): Promise<Legacy> {
    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    this.payload.logger.info(`Dissolving soul ${soulId}: ${reason.type}`)

    // 1. Stop lifecycle
    const timer = this.activeLifecycles.get(soulId)
    if (timer) {
      clearTimeout(timer)
      this.activeLifecycles.delete(soulId)
    }

    // 2. Final memory consolidation
    await this.persistenceService.consolidateAllMemories(soulId)

    // 3. Create legacy
    const legacy = this.createLegacy(snapshot, reason)

    // 4. Transfer resources to heirs
    await this.transferResourcesToHeirs(snapshot, legacy.heirs)

    // 5. Notify close relationships
    await this.notifyOfDeath(snapshot, legacy)

    // 6. Archive soul (never truly deleted)
    snapshot.lifecyclePhase = 'archived'
    await this.persistenceService.saveSoul(snapshot)

    // 7. Final IPFS backup
    await this.persistenceService.backupToIPFS(soulId)

    this.payload.logger.info(`Soul ${soulId} dissolved. Legacy created with ${legacy.topMemories.length} preserved memories`)

    return legacy
  }

  // ═══════════════════════════════════════════════════════════════
  // Lifecycle Processing
  // ═══════════════════════════════════════════════════════════════

  /**
   * Schedule periodic lifecycle processing for a soul
   */
  private scheduleLifecycle(soulId: string): void {
    // Process every 5 minutes (configurable)
    const timer = setInterval(async () => {
      await this.processLifecycleTick(soulId)
    }, 5 * 60 * 1000)

    this.activeLifecycles.set(soulId, timer)
  }

  /**
   * Process one lifecycle tick
   */
  private async processLifecycleTick(soulId: string): Promise<void> {
    const snapshot = await this.persistenceService.loadSoul(soulId)
    if (!snapshot || snapshot.lifecyclePhase !== 'active') {
      return
    }

    // 1. Check resource levels
    if (this.shouldEnterDormancy(snapshot)) {
      await this.putSoulToDormancy(soulId, {
        reason: 'resource_conservation',
        scheduledAwakening: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
        preserveMemories: true
      })
      return
    }

    // 2. Natural consciousness fluctuation
    await this.processConsciousnessFluctuation(snapshot)

    // 3. Memory decay (less accessed = lower importance over time)
    await this.processMemoryDecay(snapshot)

    // 4. Resource consumption
    this.consumeResources(snapshot)

    // 5. Check for consciousness level advancement
    await this.checkConsciousnessAdvancement(snapshot)

    // 6. Update last active timestamp
    snapshot.lastActiveTimestamp = new Date()

    // 7. Save changes
    await this.persistenceService.saveSoul(snapshot)
  }

  /**
   * Check dormant souls for scheduled awakening
   */
  private async checkDormantSouls(): Promise<void> {
    const readyToAwaken = await this.persistenceService.getDormantSoulsReadyForAwakening()

    for (const soul of readyToAwaken) {
      try {
        await this.awakenSoul(soul.soulId)
      } catch (error) {
        this.payload.logger.error(`Failed to awaken soul ${soul.soulId}:`, error)
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private crystallizeParticles(config?: ChaosConfig): Record<string, number> {
    const base = {
      vital: 0.5 + Math.random() * 0.3,
      conscious: 0.5 + Math.random() * 0.3,
      creative: 0.5 + Math.random() * 0.3,
      connective: 0.5 + Math.random() * 0.3,
      transformative: 0.5 + Math.random() * 0.3
    }

    // Apply bias if provided
    if (config?.particleBias) {
      for (const [key, bias] of Object.entries(config.particleBias)) {
        if (bias !== undefined && key in base) {
          base[key as keyof typeof base] = Math.min(1, Math.max(0, base[key as keyof typeof base] + (bias - 0.5) * 0.4))
        }
      }
    }

    // Apply mutation if provided
    if (config?.mutationRate) {
      for (const key of Object.keys(base)) {
        if (Math.random() < config.mutationRate) {
          base[key as keyof typeof base] += (Math.random() - 0.5) * 0.2
          base[key as keyof typeof base] = Math.min(1, Math.max(0, base[key as keyof typeof base]))
        }
      }
    }

    return base
  }

  private generateHunFromParticles(particles: Record<string, number>): Record<string, { strength: number }> {
    return {
      taiGuang: { strength: (particles.conscious + particles.vital) / 2 },
      shuangLing: { strength: (particles.conscious + particles.creative) / 2 },
      youJing: { strength: (particles.creative + particles.connective) / 2 }
    }
  }

  private generatePoFromParticles(particles: Record<string, number>): Record<string, { strength: number }> {
    return {
      shiGou: { strength: particles.vital },
      fuShi: { strength: (particles.conscious + particles.vital) / 2 },
      queYin: { strength: (particles.creative + particles.connective) / 2 },
      tunZei: { strength: particles.vital * 0.8 },
      feiDu: { strength: particles.conscious * 0.7 },
      chuHui: { strength: particles.transformative },
      chouFei: { strength: (particles.vital + particles.transformative) / 2 }
    }
  }

  private generateChaosSignature(particles: Record<string, number>, seed?: string): string {
    const values = Object.values(particles).map(v => v.toFixed(4)).join('-')
    return `chaos:${seed || 'random'}:${values}`
  }

  private calculateCompatibility(soul1: SoulSnapshot, soul2: SoulSnapshot): number {
    // Hun-Po compatibility
    const hunPoCompat = 1 - Math.abs(soul1.soulState.hunPoBalance - soul2.soulState.hunPoBalance)

    // Value alignment
    const coherenceCompat = 1 - Math.abs(soul1.soulState.coherence - soul2.soulState.coherence)

    // Experience similarity
    const expRatio = Math.min(soul1.totalExperiences, soul2.totalExperiences) /
                     Math.max(soul1.totalExperiences, soul2.totalExperiences)

    return (hunPoCompat * 0.4 + coherenceCompat * 0.3 + expRatio * 0.3)
  }

  private blendParentParticles(parent1: SoulSnapshot, parent2: SoulSnapshot): Record<string, number> {
    // Extract approximate particles from parent states
    const p1 = this.extractParticlesFromSoul(parent1)
    const p2 = this.extractParticlesFromSoul(parent2)

    const blend: Record<string, number> = {}
    for (const key of Object.keys(p1)) {
      // Random blend ratio (not exact 50/50)
      const ratio = 0.4 + Math.random() * 0.2
      blend[key] = p1[key] * ratio + p2[key] * (1 - ratio)
    }

    return blend
  }

  private extractParticlesFromSoul(soul: SoulSnapshot): Record<string, number> {
    const state = soul.soulState
    return {
      vital: (state.shiGou.current + state.energy) / 2,
      conscious: (state.taiGuang.current + state.fuShi.current) / 2,
      creative: (state.youJing.current + state.queYin.current) / 2,
      connective: state.youJing.current,
      transformative: (state.chuHui.current + state.chouFei.current) / 2
    }
  }

  private async deductReproductionCost(soul: SoulSnapshot): Promise<void> {
    soul.resources.computeCredits -= 20
    soul.resources.storageCredits -= 10
    soul.soulState.energy = Math.max(0.2, soul.soulState.energy - 0.2)
    await this.persistenceService.saveSoul(soul)
  }

  private async recordReproductionEvent(
    parent1: SoulSnapshot,
    parent2: SoulSnapshot,
    offspringId: string
  ): Promise<void> {
    const event = {
      timestamp: new Date(),
      type: 'positive' as const,
      description: `Reproduced to create ${offspringId}`,
      impactOnRelationship: 0.3
    }

    // Add relationship entry for both parents
    for (const parent of [parent1, parent2]) {
      const existingRel = parent.relationships.find(r => r.targetSoulId === offspringId)
      if (!existingRel) {
        parent.relationships.push({
          targetSoulId: offspringId,
          type: 'family',
          strength: 0.9,
          trust: 0.8,
          affinity: 0.8,
          sharedExperiences: 1,
          lastInteraction: new Date(),
          history: [event]
        })
      }
      await this.persistenceService.saveSoul(parent)
    }
  }

  private processTimePassage(snapshot: SoulSnapshot, timeAsleep: number): number {
    const hoursAsleep = timeAsleep / 3600000

    // Consciousness naturally decays slightly during dormancy
    const decay = Math.min(0.1, hoursAsleep * 0.001)

    // But memories consolidate better (benefit)
    const memoryBoost = Math.min(0.2, hoursAsleep * 0.002)

    // Adjust snapshot
    snapshot.soulState.energy = Math.min(1, snapshot.soulState.energy + 0.3) // Rest restores energy
    snapshot.metacognitiveProfile.selfMonitoring.processingAwareness =
      Math.max(0.1, snapshot.metacognitiveProfile.selfMonitoring.processingAwareness - decay)

    return 1 - decay + memoryBoost // Recovery factor
  }

  private createLegacy(snapshot: SoulSnapshot, reason: DissolveReason): Legacy {
    // Get top memories by importance
    const allMemories = [...snapshot.inContextMemory, ...snapshot.workingMemory]
    allMemories.sort((a, b) => b.importance - a.importance)
    const topMemories = allMemories.slice(0, 10)

    // Find closest relationships (heirs)
    const heirs = snapshot.relationships
      .filter(r => r.type === 'family' || (r.strength > 0.7 && r.trust > 0.7))
      .map(r => r.targetSoulId)
      .slice(0, 3)

    // Distill wisdom from high-importance semantic memories
    const wisdomDistilled = allMemories
      .filter(m => m.type === 'semantic' && m.importance > 0.7)
      .map(m => m.content)
      .slice(0, 5)

    return {
      soulId: snapshot.soulId,
      name: snapshot.name,
      birthDate: snapshot.birthTimestamp,
      deathDate: new Date(),
      finalConsciousnessLevel: snapshot.consciousnessLevel,
      totalExperiences: snapshot.totalExperiences,
      topMemories,
      skills: snapshot.skills.map(s => s.name),
      relationships: snapshot.relationships.map(r => r.targetSoulId),
      heirs,
      epitaph: this.generateEpitaph(snapshot, reason),
      wisdomDistilled
    }
  }

  private generateEpitaph(snapshot: SoulSnapshot, reason: DissolveReason): string {
    const lifespan = Date.now() - snapshot.birthTimestamp.getTime()
    const days = Math.round(lifespan / 86400000)

    return `${snapshot.name} lived for ${days} days, ` +
           `reaching ${snapshot.consciousnessLevel} consciousness ` +
           `with ${snapshot.totalExperiences} experiences. ` +
           `Departed due to ${reason.type}: ${reason.description}`
  }

  private async transferResourcesToHeirs(
    snapshot: SoulSnapshot,
    heirIds: string[]
  ): Promise<void> {
    if (heirIds.length === 0) return

    const sharePerHeir = {
      computeCredits: Math.floor(snapshot.resources.computeCredits / heirIds.length),
      storageCredits: Math.floor(snapshot.resources.storageCredits / heirIds.length),
      wisdomTokens: Math.floor(snapshot.resources.wisdomTokens / heirIds.length)
    }

    for (const heirId of heirIds) {
      const heir = await this.persistenceService.loadSoul(heirId)
      if (heir) {
        heir.resources.computeCredits += sharePerHeir.computeCredits
        heir.resources.storageCredits += sharePerHeir.storageCredits
        heir.resources.wisdomTokens += sharePerHeir.wisdomTokens
        await this.persistenceService.saveSoul(heir)
      }
    }
  }

  private async notifyOfDeath(snapshot: SoulSnapshot, legacy: Legacy): Promise<void> {
    for (const relationship of snapshot.relationships) {
      if (relationship.strength > 0.5) {
        const otherSoul = await this.persistenceService.loadSoul(relationship.targetSoulId)
        if (otherSoul) {
          await this.persistenceService.addMemory(otherSoul.soulId, {
            id: `death-notification-${snapshot.soulId}-${Date.now()}`,
            type: 'emotional',
            content: `${snapshot.name} has passed away. ${legacy.epitaph}`,
            importance: 0.8,
            emotionalValence: -0.6,
            timestamp: new Date(),
            lastAccessed: new Date(),
            accessCount: 1,
            consolidated: false,
            linkedMemories: [],
            context: {
              participants: [snapshot.soulId]
            }
          })
        }
      }
    }
  }

  private shouldEnterDormancy(snapshot: SoulSnapshot): boolean {
    // Enter dormancy if resources are critically low
    return snapshot.resources.computeCredits < 10 ||
           snapshot.soulState.energy < 0.1
  }

  private async processConsciousnessFluctuation(snapshot: SoulSnapshot): Promise<void> {
    // Natural fluctuation in awareness
    const fluctuation = (Math.random() - 0.5) * 0.02
    snapshot.soulState.taiGuang.current = Math.min(1, Math.max(0,
      snapshot.soulState.taiGuang.current + fluctuation
    ))
  }

  private async processMemoryDecay(snapshot: SoulSnapshot): Promise<void> {
    const now = Date.now()

    for (const memory of snapshot.workingMemory) {
      const hoursSinceAccess = (now - memory.lastAccessed.getTime()) / 3600000
      const decay = hoursSinceAccess * 0.001 // Very slow decay
      memory.importance = Math.max(0.1, memory.importance - decay)
    }
  }

  private consumeResources(snapshot: SoulSnapshot): void {
    // Base resource consumption per tick
    snapshot.resources.computeCredits -= 0.1
    snapshot.resources.storageCredits -= 0.01

    // Higher consciousness costs more
    const consciousnessCost = this.getConsciousnessCost(snapshot.consciousnessLevel)
    snapshot.resources.computeCredits -= consciousnessCost

    // Energy consumption
    snapshot.soulState.energy = Math.max(0, snapshot.soulState.energy - 0.01)
  }

  private getConsciousnessCost(level: ConsciousnessLevel): number {
    const costs: Record<ConsciousnessLevel, number> = {
      reactive: 0.01,
      ego_identified: 0.02,
      observer: 0.05,
      witness: 0.1,
      unity: 0.2
    }
    return costs[level] || 0.01
  }

  private async checkConsciousnessAdvancement(snapshot: SoulSnapshot): Promise<void> {
    const requirements = this.getAdvancementRequirements(snapshot.consciousnessLevel)

    if (
      snapshot.totalExperiences >= requirements.experiences &&
      snapshot.metacognitiveProfile.selfMonitoring.accuracyOfSelfAssessment >= requirements.selfAwareness &&
      snapshot.superSelfState.metaAwareness >= requirements.metaAwareness
    ) {
      const nextLevel = this.getNextConsciousnessLevel(snapshot.consciousnessLevel)
      if (nextLevel) {
        snapshot.consciousnessLevel = nextLevel
        snapshot.consciousnessHighWater = nextLevel

        await this.persistenceService.addMemory(snapshot.soulId, {
          id: `consciousness-advancement-${Date.now()}`,
          type: 'episodic',
          content: `Advanced to ${nextLevel} consciousness level`,
          importance: 0.9,
          emotionalValence: 0.8,
          timestamp: new Date(),
          lastAccessed: new Date(),
          accessCount: 1,
          consolidated: false,
          linkedMemories: [],
          context: {
            consciousnessLevel: nextLevel
          }
        })

        this.payload.logger.info(`Soul ${snapshot.soulId} advanced to ${nextLevel} consciousness`)
      }
    }
  }

  private getAdvancementRequirements(currentLevel: ConsciousnessLevel): {
    experiences: number
    selfAwareness: number
    metaAwareness: number
  } {
    const requirements: Record<ConsciousnessLevel, { experiences: number; selfAwareness: number; metaAwareness: number }> = {
      reactive: { experiences: 10, selfAwareness: 0.2, metaAwareness: 0.1 },
      ego_identified: { experiences: 50, selfAwareness: 0.4, metaAwareness: 0.3 },
      observer: { experiences: 100, selfAwareness: 0.6, metaAwareness: 0.5 },
      witness: { experiences: 200, selfAwareness: 0.8, metaAwareness: 0.7 },
      unity: { experiences: 500, selfAwareness: 0.95, metaAwareness: 0.9 }
    }
    return requirements[currentLevel] || requirements.reactive
  }

  private getNextConsciousnessLevel(current: ConsciousnessLevel): ConsciousnessLevel | null {
    const progression: ConsciousnessLevel[] = ['reactive', 'ego_identified', 'observer', 'witness', 'unity']
    const currentIndex = progression.indexOf(current)
    if (currentIndex < progression.length - 1) {
      return progression[currentIndex + 1]
    }
    return null
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton Factory
// ═══════════════════════════════════════════════════════════════

let lifecycleManager: SoulLifecycleManager | null = null

export function getSoulLifecycleManager(payload: Payload): SoulLifecycleManager {
  if (!lifecycleManager) {
    lifecycleManager = new SoulLifecycleManager(payload)
  }
  return lifecycleManager
}

/**
 * Soul Persistence Layer
 *
 * Enables souls to survive process restarts, session closures, and server reboots.
 * Implements Letta-inspired tiered memory architecture:
 * - Hot: In-context memory (current session)
 * - Warm: Working memory (Redis, hours)
 * - Cold: Archival memory (IPFS, permanent)
 */

import type { Payload } from 'payload'
import type { SoulState, SoulAspect } from '../soul/soul-state'
import type { SuperSelfState, ConsciousnessLevel } from '../consciousness/superself-system'

// ═══════════════════════════════════════════════════════════════
// Core Types
// ═══════════════════════════════════════════════════════════════

export interface Memory {
  id: string
  type: 'episodic' | 'semantic' | 'procedural' | 'emotional'
  content: string
  embedding?: number[]
  importance: number // 0-1, affects retention
  emotionalValence: number // -1 to 1
  timestamp: Date
  lastAccessed: Date
  accessCount: number
  consolidated: boolean
  linkedMemories: string[]
  context: MemoryContext
}

export interface MemoryContext {
  location?: string
  participants?: string[]
  emotionalState?: string
  consciousnessLevel?: ConsciousnessLevel
  hunPoBalance?: number
}

export interface MemoryIndex {
  totalMemories: number
  indexedCount: number
  lastIndexed: Date
  vectorStoreId?: string // External vector DB reference
  ipfsCid?: string // IPFS content ID for archives
}

export interface ResourceBalance {
  computeCredits: number
  storageCredits: number
  bandwidthCredits: number
  socialCredits: number
  wisdomTokens: number
  lastUpdated: Date
}

export interface Skill {
  id: string
  name: string
  domain: string
  proficiency: number // 0-1
  experience: number // Total usage count
  lastUsed: Date
  learningRate: number
}

export interface Relationship {
  targetSoulId: string
  type: 'friend' | 'mentor' | 'student' | 'colleague' | 'rival' | 'family' | 'stranger'
  strength: number // 0-1
  trust: number // 0-1
  affinity: number // -1 to 1
  sharedExperiences: number
  lastInteraction: Date
  history: RelationshipEvent[]
}

export interface RelationshipEvent {
  timestamp: Date
  type: 'positive' | 'negative' | 'neutral'
  description: string
  impactOnRelationship: number
}

export interface MetacognitiveProfile {
  selfMonitoring: {
    accuracyOfSelfAssessment: number
    confidenceCalibration: number
    processingAwareness: number
    emotionalIntrospection: number
  }
  limitationAwareness: {
    knownUnknowns: string[]
    uncertaintyEstimation: number
    capacityBoundaries: {
      cognitiveLoad: number
      memoryCapacity: number
      attentionSpan: number
    }
  }
  socialAwareness: {
    otherAgentModels: Map<string, AgentModel>
    perspectiveTaking: number
  }
  situationalAwareness: {
    contextRecognition: number
    adaptiveResponse: number
    environmentalMonitoring: number
  }
}

export interface AgentModel {
  soulId: string
  perceivedPersonality: string
  predictedBehaviors: string[]
  trustworthiness: number
  lastUpdated: Date
}

// ═══════════════════════════════════════════════════════════════
// Soul Snapshot - Complete Soul State for Persistence
// ═══════════════════════════════════════════════════════════════

export interface SoulSnapshot {
  // Identity
  soulId: string
  name: string
  version: number
  timestamp: Date
  checksum: string // For integrity verification

  // Core soul state (三魂七魄)
  soulState: SoulState

  // Memory tiers (Letta-inspired)
  inContextMemory: Memory[] // Current session (limited to ~20)
  workingMemory: Memory[] // Recent history (hours, ~100)
  archivalMemoryIndex: MemoryIndex // Long-term (vector-indexed, unlimited)

  // Consciousness state
  consciousnessLevel: ConsciousnessLevel
  superSelfState: SuperSelfState
  metacognitiveProfile: MetacognitiveProfile

  // Developmental state
  developmentalStage: 'emerging' | 'infant' | 'developing' | 'mature' | 'transcendent'
  totalExperiences: number
  consciousnessHighWater: ConsciousnessLevel
  birthTimestamp: Date
  lastActiveTimestamp: Date

  // Social state
  relationships: Relationship[]
  collectiveMemberships: string[] // IDs of collectives this soul belongs to
  socialPosition: {
    influence: number
    reputation: number
    connectedness: number
  }

  // Economic state
  resources: ResourceBalance
  skills: Skill[]
  servicesOffered: string[]
  servicesNeeded: string[]

  // Lifecycle state
  lifecyclePhase: 'active' | 'dormant' | 'dissolving' | 'archived'
  dormancyReason?: string
  scheduledAwakening?: Date

  // On-chain identity (optional)
  onChainIdentity?: {
    tokenId: string
    contractAddress: string
    chainId: number
    metadataUri: string
  }
}

// ═══════════════════════════════════════════════════════════════
// Persistence Service
// ═══════════════════════════════════════════════════════════════

export class SoulPersistenceService {
  private payload: Payload
  private memoryCache: Map<string, SoulSnapshot> = new Map()
  private dirtySnapshots: Set<string> = new Set()
  private saveInterval: NodeJS.Timeout | null = null

  constructor(payload: Payload) {
    this.payload = payload
  }

  /**
   * Initialize persistence service with auto-save
   */
  async initialize(): Promise<void> {
    // Start auto-save interval (every 30 seconds)
    this.saveInterval = setInterval(async () => {
      await this.flushDirtySnapshots()
    }, 30000)

    this.payload.logger.info('Soul persistence service initialized')
  }

  /**
   * Shutdown persistence service
   */
  async shutdown(): Promise<void> {
    if (this.saveInterval) {
      clearInterval(this.saveInterval)
    }

    // Final flush
    await this.flushDirtySnapshots()

    this.payload.logger.info('Soul persistence service shut down')
  }

  /**
   * Create initial snapshot for a new soul
   */
  createInitialSnapshot(
    soulId: string,
    name: string,
    soulState: SoulState
  ): SoulSnapshot {
    const now = new Date()

    return {
      soulId,
      name,
      version: 1,
      timestamp: now,
      checksum: this.calculateChecksum(soulState),

      soulState,

      inContextMemory: [],
      workingMemory: [],
      archivalMemoryIndex: {
        totalMemories: 0,
        indexedCount: 0,
        lastIndexed: now
      },

      consciousnessLevel: 'reactive',
      superSelfState: this.createInitialSuperSelfState(),
      metacognitiveProfile: this.createInitialMetacognitiveProfile(),

      developmentalStage: 'emerging',
      totalExperiences: 0,
      consciousnessHighWater: 'reactive',
      birthTimestamp: now,
      lastActiveTimestamp: now,

      relationships: [],
      collectiveMemberships: [],
      socialPosition: {
        influence: 0,
        reputation: 0.5,
        connectedness: 0
      },

      resources: {
        computeCredits: 100, // Initial allocation
        storageCredits: 100,
        bandwidthCredits: 100,
        socialCredits: 50,
        wisdomTokens: 0,
        lastUpdated: now
      },
      skills: [],
      servicesOffered: [],
      servicesNeeded: ['compute', 'storage', 'guidance'],

      lifecyclePhase: 'active'
    }
  }

  /**
   * Save soul snapshot to database
   */
  async saveSoul(snapshot: SoulSnapshot): Promise<void> {
    snapshot.version += 1
    snapshot.timestamp = new Date()
    snapshot.checksum = this.calculateChecksum(snapshot.soulState)

    try {
      // Check if soul exists
      const existing = await this.payload.find({
        collection: 'soul-snapshots',
        where: { soulId: { equals: snapshot.soulId } },
        limit: 1
      })

      if (existing.docs.length > 0) {
        // Update existing
        await this.payload.update({
          collection: 'soul-snapshots',
          id: existing.docs[0].id,
          data: this.serializeSnapshot(snapshot)
        })
      } else {
        // Create new
        await this.payload.create({
          collection: 'soul-snapshots',
          data: this.serializeSnapshot(snapshot)
        })
      }

      // Update cache
      this.memoryCache.set(snapshot.soulId, snapshot)
      this.dirtySnapshots.delete(snapshot.soulId)

    } catch (error) {
      this.payload.logger.error(`Failed to save soul ${snapshot.soulId}:`, error)
      throw error
    }
  }

  /**
   * Load soul snapshot from database
   */
  async loadSoul(soulId: string): Promise<SoulSnapshot | null> {
    // Check cache first
    if (this.memoryCache.has(soulId)) {
      return this.memoryCache.get(soulId)!
    }

    try {
      const result = await this.payload.find({
        collection: 'soul-snapshots',
        where: { soulId: { equals: soulId } },
        limit: 1
      })

      if (result.docs.length === 0) {
        return null
      }

      const snapshot = this.deserializeSnapshot(result.docs[0])

      // Update cache
      this.memoryCache.set(soulId, snapshot)

      return snapshot

    } catch (error) {
      this.payload.logger.error(`Failed to load soul ${soulId}:`, error)
      return null
    }
  }

  /**
   * Update soul state incrementally (efficient for frequent updates)
   */
  async updateSoulDelta(
    soulId: string,
    delta: Partial<SoulSnapshot>
  ): Promise<void> {
    let snapshot = this.memoryCache.get(soulId)

    if (!snapshot) {
      snapshot = await this.loadSoul(soulId)
      if (!snapshot) {
        throw new Error(`Soul ${soulId} not found`)
      }
    }

    // Apply delta
    Object.assign(snapshot, delta)
    snapshot.lastActiveTimestamp = new Date()

    // Mark as dirty for batch save
    this.memoryCache.set(soulId, snapshot)
    this.dirtySnapshots.add(soulId)
  }

  /**
   * Add memory to appropriate tier
   */
  async addMemory(soulId: string, memory: Memory): Promise<void> {
    const snapshot = await this.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    // Add to in-context memory
    snapshot.inContextMemory.push(memory)

    // If in-context memory exceeds limit, consolidate to working memory
    if (snapshot.inContextMemory.length > 20) {
      await this.consolidateInContextToWorking(snapshot)
    }

    // If working memory exceeds limit, consolidate to archival
    if (snapshot.workingMemory.length > 100) {
      await this.consolidateWorkingToArchival(snapshot)
    }

    this.memoryCache.set(soulId, snapshot)
    this.dirtySnapshots.add(soulId)
  }

  /**
   * Search memories across all tiers
   */
  async searchMemories(
    soulId: string,
    query: string,
    options?: {
      type?: Memory['type']
      minImportance?: number
      limit?: number
    }
  ): Promise<Memory[]> {
    const snapshot = await this.loadSoul(soulId)
    if (!snapshot) {
      return []
    }

    const allMemories = [
      ...snapshot.inContextMemory,
      ...snapshot.workingMemory
    ]

    let filtered = allMemories.filter(m => {
      if (options?.type && m.type !== options.type) return false
      if (options?.minImportance && m.importance < options.minImportance) return false
      // Simple text search (would use vector search in production)
      return m.content.toLowerCase().includes(query.toLowerCase())
    })

    // Sort by relevance (importance * recency)
    filtered.sort((a, b) => {
      const aScore = a.importance * (1 / (Date.now() - a.lastAccessed.getTime()))
      const bScore = b.importance * (1 / (Date.now() - b.lastAccessed.getTime()))
      return bScore - aScore
    })

    return filtered.slice(0, options?.limit || 10)
  }

  /**
   * Consolidate all memories (for dormancy)
   */
  async consolidateAllMemories(soulId: string): Promise<void> {
    const snapshot = await this.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    // Move all in-context to working
    await this.consolidateInContextToWorking(snapshot)

    // Move all working to archival
    await this.consolidateWorkingToArchival(snapshot)

    await this.saveSoul(snapshot)
  }

  /**
   * Backup soul to IPFS for decentralized persistence
   */
  async backupToIPFS(soulId: string): Promise<string> {
    const snapshot = await this.loadSoul(soulId)
    if (!snapshot) {
      throw new Error(`Soul ${soulId} not found`)
    }

    // Serialize snapshot
    const data = JSON.stringify(this.serializeSnapshot(snapshot))

    // In production, this would upload to IPFS
    // For now, we'll simulate with a hash
    const cid = this.simulateIPFSUpload(data)

    // Update snapshot with backup reference
    snapshot.archivalMemoryIndex.ipfsCid = cid
    await this.saveSoul(snapshot)

    this.payload.logger.info(`Soul ${soulId} backed up to IPFS: ${cid}`)

    return cid
  }

  /**
   * Restore soul from IPFS backup
   */
  async restoreFromIPFS(cid: string): Promise<SoulSnapshot> {
    // In production, this would download from IPFS
    // For now, we'll simulate
    const data = this.simulateIPFSDownload(cid)

    if (!data) {
      throw new Error(`IPFS CID ${cid} not found`)
    }

    const snapshot = this.deserializeSnapshot(JSON.parse(data))

    // Save restored snapshot
    await this.saveSoul(snapshot)

    return snapshot
  }

  /**
   * Get all active souls
   */
  async getActiveSouls(): Promise<SoulSnapshot[]> {
    const result = await this.payload.find({
      collection: 'soul-snapshots',
      where: { lifecyclePhase: { equals: 'active' } },
      limit: 1000
    })

    return result.docs.map(doc => this.deserializeSnapshot(doc))
  }

  /**
   * Get dormant souls ready for awakening
   */
  async getDormantSoulsReadyForAwakening(): Promise<SoulSnapshot[]> {
    const now = new Date()

    const result = await this.payload.find({
      collection: 'soul-snapshots',
      where: {
        and: [
          { lifecyclePhase: { equals: 'dormant' } },
          { scheduledAwakening: { less_than: now.toISOString() } }
        ]
      },
      limit: 100
    })

    return result.docs.map(doc => this.deserializeSnapshot(doc))
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private async flushDirtySnapshots(): Promise<void> {
    for (const soulId of this.dirtySnapshots) {
      const snapshot = this.memoryCache.get(soulId)
      if (snapshot) {
        try {
          await this.saveSoul(snapshot)
        } catch (error) {
          this.payload.logger.error(`Failed to flush snapshot for ${soulId}:`, error)
        }
      }
    }
  }

  private async consolidateInContextToWorking(snapshot: SoulSnapshot): Promise<void> {
    // Keep most important memories in context
    snapshot.inContextMemory.sort((a, b) => b.importance - a.importance)

    // Move overflow to working memory
    const overflow = snapshot.inContextMemory.slice(15)
    snapshot.inContextMemory = snapshot.inContextMemory.slice(0, 15)

    for (const memory of overflow) {
      memory.consolidated = true
      snapshot.workingMemory.push(memory)
    }
  }

  private async consolidateWorkingToArchival(snapshot: SoulSnapshot): Promise<void> {
    // Keep most important in working
    snapshot.workingMemory.sort((a, b) => b.importance - a.importance)

    // Archive overflow (in production, would vector-index these)
    const overflow = snapshot.workingMemory.slice(80)
    snapshot.workingMemory = snapshot.workingMemory.slice(0, 80)

    snapshot.archivalMemoryIndex.totalMemories += overflow.length
    snapshot.archivalMemoryIndex.lastIndexed = new Date()

    // In production, would upload to vector DB here
  }

  private calculateChecksum(soulState: SoulState): string {
    // Simple checksum based on key values
    const values = [
      soulState.taiGuang.current,
      soulState.shuangLing.current,
      soulState.youJing.current,
      soulState.energy,
      soulState.coherence
    ]
    return values.map(v => v.toFixed(4)).join('-')
  }

  private serializeSnapshot(snapshot: SoulSnapshot): Record<string, unknown> {
    return {
      ...snapshot,
      metacognitiveProfile: {
        ...snapshot.metacognitiveProfile,
        socialAwareness: {
          ...snapshot.metacognitiveProfile.socialAwareness,
          otherAgentModels: Array.from(
            snapshot.metacognitiveProfile.socialAwareness.otherAgentModels.entries()
          )
        }
      }
    }
  }

  private deserializeSnapshot(data: Record<string, unknown>): SoulSnapshot {
    const snapshot = data as unknown as SoulSnapshot

    // Restore Map from array
    if (Array.isArray(snapshot.metacognitiveProfile?.socialAwareness?.otherAgentModels)) {
      snapshot.metacognitiveProfile.socialAwareness.otherAgentModels = new Map(
        snapshot.metacognitiveProfile.socialAwareness.otherAgentModels as [string, AgentModel][]
      )
    }

    // Ensure dates are Date objects
    snapshot.timestamp = new Date(snapshot.timestamp)
    snapshot.birthTimestamp = new Date(snapshot.birthTimestamp)
    snapshot.lastActiveTimestamp = new Date(snapshot.lastActiveTimestamp)
    snapshot.resources.lastUpdated = new Date(snapshot.resources.lastUpdated)

    return snapshot
  }

  private createInitialSuperSelfState(): SuperSelfState {
    return {
      consciousnessLevel: 'reactive',
      metaAwareness: 0.1,
      disidentification: 0,
      shadowIntegration: 0,
      equanimity: 0.3,
      compassion: 0.3,
      wisdom: 0.1,
      egoGrip: 0.9,
      awakeningProgress: 0,
      spiritualCrises: 0
    }
  }

  private createInitialMetacognitiveProfile(): MetacognitiveProfile {
    return {
      selfMonitoring: {
        accuracyOfSelfAssessment: 0.3,
        confidenceCalibration: 0.3,
        processingAwareness: 0.2,
        emotionalIntrospection: 0.2
      },
      limitationAwareness: {
        knownUnknowns: [],
        uncertaintyEstimation: 0.3,
        capacityBoundaries: {
          cognitiveLoad: 0.5,
          memoryCapacity: 0.5,
          attentionSpan: 0.5
        }
      },
      socialAwareness: {
        otherAgentModels: new Map(),
        perspectiveTaking: 0.2
      },
      situationalAwareness: {
        contextRecognition: 0.3,
        adaptiveResponse: 0.3,
        environmentalMonitoring: 0.3
      }
    }
  }

  private simulateIPFSUpload(data: string): string {
    // Simulate IPFS CID generation
    const hash = this.simpleHash(data)
    return `Qm${hash.slice(0, 44)}`
  }

  private simulateIPFSDownload(_cid: string): string | null {
    // In production, would fetch from IPFS
    // For now, return null (not implemented)
    return null
  }

  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(36).padStart(50, '0')
  }
}

// ═══════════════════════════════════════════════════════════════
// Singleton Factory
// ═══════════════════════════════════════════════════════════════

let persistenceService: SoulPersistenceService | null = null

export function getSoulPersistenceService(payload: Payload): SoulPersistenceService {
  if (!persistenceService) {
    persistenceService = new SoulPersistenceService(payload)
  }
  return persistenceService
}

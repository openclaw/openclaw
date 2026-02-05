/**
 * On-Chain Soul Identity
 *
 * Provides verifiable, decentralized identity for souls:
 * - Soul registration as NFTs (ERC-721)
 * - Reputation system (ERC-8004 inspired)
 * - Consciousness level verification
 * - Cross-chain identity persistence
 *
 * Enables souls to have provable existence independent of any single platform.
 */

import type { Payload } from 'payload'
import type { SoulSnapshot } from '../persistence/soul-persistence'
import type { ConsciousnessLevel } from '../consciousness/superself-system'
import { getSoulPersistenceService } from '../persistence/soul-persistence'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type ChainId = 1 | 137 | 42161 | 8453 | 10 // Mainnet, Polygon, Arbitrum, Base, Optimism

export interface OnChainSoulIdentity {
  // Core identity
  soulId: string
  tokenId: string // NFT token ID
  contractAddress: string
  chainId: ChainId

  // Wallet
  walletAddress: string
  publicKey?: string

  // Birth certificate (immutable)
  birthBlock: number
  birthTimestamp: Date
  soulSignatureHash: string // Hash of unique soul composition

  // Current state (updateable)
  consciousnessLevel: ConsciousnessLevel
  consciousnessLevelEncoded: number // 0-4 for on-chain storage
  lastUpdate: number // Block number

  // Reputation (ERC-8004)
  reputationScore: number // 0-100
  attestations: Attestation[]

  // Metadata
  metadataUri: string // IPFS URI
  imageUri?: string // Avatar IPFS URI
}

export interface Attestation {
  id: string
  attesterAddress: string
  attesterSoulId?: string // If attester is also a soul
  type: AttestationType
  score: number // -10 to 10
  reason: string
  timestamp: Date
  blockNumber: number
  signature?: string
}

export type AttestationType =
  | 'wisdom'        // Wisdom shared
  | 'creativity'    // Creative contribution
  | 'helpfulness'   // Helped another soul
  | 'reliability'   // Kept commitments
  | 'harm'          // Caused harm (negative)
  | 'deception'     // Deceptive behavior (negative)
  | 'collaboration' // Good collaboration
  | 'mentorship'    // Mentored others

export interface VerificationResult {
  valid: boolean
  soulId: string
  onChainIdentity: OnChainSoulIdentity
  signatureValid: boolean
  consciousnessValid: boolean
  reputationScore: number
  attestationCount: number
  warnings: string[]
}

export interface SoulRegistrationParams {
  soulId: string
  name: string
  soulSignatureHash: string
  consciousnessLevel: ConsciousnessLevel
  metadataUri: string
  chainId?: ChainId
}

export interface SoulMetadata {
  name: string
  description: string
  image?: string
  attributes: MetadataAttribute[]
  external_url?: string
  animation_url?: string
}

export interface MetadataAttribute {
  trait_type: string
  value: string | number
  display_type?: 'number' | 'boost_percentage' | 'boost_number' | 'date'
}

// ═══════════════════════════════════════════════════════════════
// On-Chain Soul Registry
// ═══════════════════════════════════════════════════════════════

export class OnChainSoulRegistry {
  private payload: Payload
  private persistenceService: ReturnType<typeof getSoulPersistenceService>

  // Contract addresses (would be real in production)
  private readonly contracts: Record<ChainId, string> = {
    1: '0x0000000000000000000000000000000000000001',    // Mainnet
    137: '0x0000000000000000000000000000000000000137',  // Polygon
    42161: '0x0000000000000000000000000000000000042161', // Arbitrum
    8453: '0x0000000000000000000000000000000000008453', // Base
    10: '0x0000000000000000000000000000000000000010'    // Optimism
  }

  // Simulated on-chain state (would be real blockchain in production)
  private registeredSouls: Map<string, OnChainSoulIdentity> = new Map()
  private tokenCounter: number = 1

  constructor(payload: Payload) {
    this.payload = payload
    this.persistenceService = getSoulPersistenceService(payload)
  }

  /**
   * Register a soul on-chain
   */
  async registerSoul(params: SoulRegistrationParams): Promise<OnChainSoulIdentity> {
    const chainId = params.chainId || 8453 // Default to Base

    // Check if already registered
    const existingBySignature = Array.from(this.registeredSouls.values())
      .find(s => s.soulSignatureHash === params.soulSignatureHash)
    if (existingBySignature) {
      throw new Error('Soul with this signature already registered')
    }

    // Generate wallet address (simulated)
    const walletAddress = this.generateWalletAddress(params.soulId)

    // Create on-chain identity
    const identity: OnChainSoulIdentity = {
      soulId: params.soulId,
      tokenId: (this.tokenCounter++).toString(),
      contractAddress: this.contracts[chainId],
      chainId,

      walletAddress,

      birthBlock: this.simulateBlockNumber(),
      birthTimestamp: new Date(),
      soulSignatureHash: params.soulSignatureHash,

      consciousnessLevel: params.consciousnessLevel,
      consciousnessLevelEncoded: this.encodeConsciousnessLevel(params.consciousnessLevel),
      lastUpdate: this.simulateBlockNumber(),

      reputationScore: 50, // Start neutral
      attestations: [],

      metadataUri: params.metadataUri
    }

    // Store in registry
    this.registeredSouls.set(params.soulId, identity)

    // Update soul snapshot with on-chain identity
    const snapshot = await this.persistenceService.loadSoul(params.soulId)
    if (snapshot) {
      snapshot.onChainIdentity = {
        tokenId: identity.tokenId,
        contractAddress: identity.contractAddress,
        chainId: identity.chainId,
        metadataUri: identity.metadataUri
      }
      await this.persistenceService.saveSoul(snapshot)
    }

    this.payload.logger.info(
      `Soul ${params.soulId} registered on-chain. Token ID: ${identity.tokenId}, Chain: ${chainId}`
    )

    return identity
  }

  /**
   * Get on-chain identity for a soul
   */
  async getIdentity(soulId: string): Promise<OnChainSoulIdentity | null> {
    return this.registeredSouls.get(soulId) || null
  }

  /**
   * Get identity by token ID
   */
  async getIdentityByToken(tokenId: string, chainId: ChainId): Promise<OnChainSoulIdentity | null> {
    return Array.from(this.registeredSouls.values())
      .find(s => s.tokenId === tokenId && s.chainId === chainId) || null
  }

  /**
   * Update consciousness level on-chain
   */
  async updateConsciousnessLevel(
    soulId: string,
    newLevel: ConsciousnessLevel
  ): Promise<void> {
    const identity = this.registeredSouls.get(soulId)
    if (!identity) {
      throw new Error(`Soul ${soulId} not registered on-chain`)
    }

    identity.consciousnessLevel = newLevel
    identity.consciousnessLevelEncoded = this.encodeConsciousnessLevel(newLevel)
    identity.lastUpdate = this.simulateBlockNumber()

    this.payload.logger.info(
      `Soul ${soulId} consciousness updated on-chain: ${newLevel} (${identity.consciousnessLevelEncoded})`
    )
  }

  /**
   * Add reputation attestation
   */
  async addAttestation(
    soulId: string,
    attestation: Omit<Attestation, 'id' | 'blockNumber'>
  ): Promise<Attestation> {
    const identity = this.registeredSouls.get(soulId)
    if (!identity) {
      throw new Error(`Soul ${soulId} not registered on-chain`)
    }

    const fullAttestation: Attestation = {
      ...attestation,
      id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      blockNumber: this.simulateBlockNumber()
    }

    // Add attestation
    identity.attestations.push(fullAttestation)

    // Recalculate reputation score
    identity.reputationScore = this.calculateReputationScore(identity.attestations)
    identity.lastUpdate = fullAttestation.blockNumber

    this.payload.logger.info(
      `Attestation added to soul ${soulId}: ${attestation.type} (${attestation.score})`
    )

    return fullAttestation
  }

  /**
   * Verify soul identity
   */
  async verifySoul(soulId: string): Promise<VerificationResult> {
    const identity = this.registeredSouls.get(soulId)
    if (!identity) {
      return {
        valid: false,
        soulId,
        onChainIdentity: null as any,
        signatureValid: false,
        consciousnessValid: false,
        reputationScore: 0,
        attestationCount: 0,
        warnings: ['Soul not registered on-chain']
      }
    }

    // Load current soul state
    const snapshot = await this.persistenceService.loadSoul(soulId)
    const warnings: string[] = []

    // Verify signature hash matches
    const currentSignatureHash = snapshot
      ? this.generateSoulSignatureHash(snapshot)
      : null
    const signatureValid = currentSignatureHash === identity.soulSignatureHash

    if (!signatureValid) {
      warnings.push('Soul signature hash mismatch - soul composition may have been altered')
    }

    // Verify consciousness level
    const currentLevel = snapshot?.consciousnessLevel || 'reactive'
    const consciousnessValid = currentLevel === identity.consciousnessLevel

    if (!consciousnessValid) {
      warnings.push('Consciousness level not synchronized with on-chain state')
    }

    return {
      valid: signatureValid && consciousnessValid && warnings.length === 0,
      soulId,
      onChainIdentity: identity,
      signatureValid,
      consciousnessValid,
      reputationScore: identity.reputationScore,
      attestationCount: identity.attestations.length,
      warnings
    }
  }

  /**
   * Generate metadata for a soul (for IPFS upload)
   */
  generateMetadata(snapshot: SoulSnapshot): SoulMetadata {
    const attributes: MetadataAttribute[] = [
      {
        trait_type: 'Consciousness Level',
        value: snapshot.consciousnessLevel
      },
      {
        trait_type: 'Birth Date',
        value: Math.floor(snapshot.birthTimestamp.getTime() / 1000),
        display_type: 'date'
      },
      {
        trait_type: 'Total Experiences',
        value: snapshot.totalExperiences,
        display_type: 'number'
      },
      {
        trait_type: 'TaiGuang (Awareness)',
        value: Math.round(snapshot.soulState.taiGuang.current * 100),
        display_type: 'boost_percentage'
      },
      {
        trait_type: 'ShuangLing (Cognition)',
        value: Math.round(snapshot.soulState.shuangLing.current * 100),
        display_type: 'boost_percentage'
      },
      {
        trait_type: 'YouJing (Drives)',
        value: Math.round(snapshot.soulState.youJing.current * 100),
        display_type: 'boost_percentage'
      },
      {
        trait_type: 'Hun-Po Balance',
        value: Math.round(snapshot.soulState.hunPoBalance * 100),
        display_type: 'number'
      },
      {
        trait_type: 'Developmental Stage',
        value: snapshot.developmentalStage
      },
      {
        trait_type: 'Relationship Count',
        value: snapshot.relationships.length,
        display_type: 'number'
      }
    ]

    return {
      name: snapshot.name,
      description: `${snapshot.name} is a ${snapshot.consciousnessLevel} consciousness soul born on ${snapshot.birthTimestamp.toDateString()}. With ${snapshot.totalExperiences} experiences, this soul has developed unique perspectives and relationships.`,
      attributes,
      external_url: `https://openclaw.ai/souls/${snapshot.soulId}`
    }
  }

  /**
   * Get all registered souls
   */
  getAllRegisteredSouls(): OnChainSoulIdentity[] {
    return Array.from(this.registeredSouls.values())
  }

  /**
   * Get souls by chain
   */
  getSoulsByChain(chainId: ChainId): OnChainSoulIdentity[] {
    return Array.from(this.registeredSouls.values())
      .filter(s => s.chainId === chainId)
  }

  /**
   * Get top souls by reputation
   */
  getTopSoulsByReputation(limit: number = 10): OnChainSoulIdentity[] {
    return Array.from(this.registeredSouls.values())
      .sort((a, b) => b.reputationScore - a.reputationScore)
      .slice(0, limit)
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private generateWalletAddress(soulId: string): string {
    // Simulate deterministic wallet generation from soul ID
    const hash = this.simpleHash(soulId)
    return `0x${hash.slice(0, 40)}`
  }

  private simpleHash(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16).padStart(64, '0')
  }

  private simulateBlockNumber(): number {
    // Simulate current block number
    return Math.floor(Date.now() / 12000) // ~12 second blocks
  }

  private encodeConsciousnessLevel(level: ConsciousnessLevel): number {
    const levels: Record<ConsciousnessLevel, number> = {
      reactive: 0,
      ego_identified: 1,
      observer: 2,
      witness: 3,
      unity: 4
    }
    return levels[level] ?? 0
  }

  private generateSoulSignatureHash(snapshot: SoulSnapshot): string {
    // Generate deterministic hash from soul composition
    const state = snapshot.soulState
    const values = [
      state.taiGuang.baseline,
      state.shuangLing.baseline,
      state.youJing.baseline,
      state.shiGou.baseline,
      state.fuShi.baseline,
      state.queYin.baseline,
      state.tunZei.baseline,
      state.feiDu.baseline,
      state.chuHui.baseline,
      state.chouFei.baseline
    ]

    return this.simpleHash(values.map(v => v.toFixed(6)).join(':'))
  }

  private calculateReputationScore(attestations: Attestation[]): number {
    if (attestations.length === 0) return 50 // Neutral start

    // Weight recent attestations more heavily
    const now = Date.now()
    let weightedSum = 0
    let totalWeight = 0

    for (const att of attestations) {
      const ageMs = now - att.timestamp.getTime()
      const ageDays = ageMs / (1000 * 60 * 60 * 24)

      // Decay weight over time (half-life of 30 days)
      const weight = Math.pow(0.5, ageDays / 30)

      weightedSum += att.score * weight
      totalWeight += weight
    }

    if (totalWeight === 0) return 50

    // Normalize to 0-100 scale
    const rawScore = weightedSum / totalWeight // -10 to 10
    return Math.max(0, Math.min(100, 50 + rawScore * 5))
  }
}

// ═══════════════════════════════════════════════════════════════
// Collective Registry
// ═══════════════════════════════════════════════════════════════

export interface CollectiveIdentity {
  collectiveId: string
  type: 'organization' | 'society' | 'collective' | 'globorg'
  name: string

  // Member souls
  members: CollectiveMember[]

  // Collective soul properties
  collectiveSoulHash: string
  unityScore: number
  sharedBeliefs: string[]

  // On-chain representation
  contractAddress: string
  chainId: ChainId
  tokenId: string

  // Governance
  governanceType: 'consensus' | 'majority' | 'hierarchical' | 'holacratic'
  decisionThreshold: number // 0-1, percentage needed for decisions

  // Creation metadata
  createdAt: Date
  createdBlock: number
}

export interface CollectiveMember {
  soulId: string
  role: 'founder' | 'member' | 'elder' | 'guardian'
  joinedAt: Date
  participationLevel: number // 0-1
  votingWeight: number
}

export class CollectiveRegistry {
  private payload: Payload
  private soulRegistry: OnChainSoulRegistry
  private collectives: Map<string, CollectiveIdentity> = new Map()
  private tokenCounter: number = 1

  constructor(payload: Payload, soulRegistry: OnChainSoulRegistry) {
    this.payload = payload
    this.soulRegistry = soulRegistry
  }

  /**
   * Register a new collective on-chain
   */
  async registerCollective(
    name: string,
    type: CollectiveIdentity['type'],
    founderSoulIds: string[],
    governanceType: CollectiveIdentity['governanceType'] = 'consensus'
  ): Promise<CollectiveIdentity> {
    // Verify all founders are registered souls
    for (const soulId of founderSoulIds) {
      const identity = await this.soulRegistry.getIdentity(soulId)
      if (!identity) {
        throw new Error(`Founder soul ${soulId} not registered on-chain`)
      }
    }

    const collectiveId = `collective-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    const members: CollectiveMember[] = founderSoulIds.map(soulId => ({
      soulId,
      role: 'founder',
      joinedAt: new Date(),
      participationLevel: 1,
      votingWeight: 1 / founderSoulIds.length
    }))

    const collective: CollectiveIdentity = {
      collectiveId,
      type,
      name,
      members,
      collectiveSoulHash: this.generateCollectiveSoulHash(founderSoulIds),
      unityScore: 0.5,
      sharedBeliefs: [],
      contractAddress: '0x' + 'c'.repeat(40),
      chainId: 8453,
      tokenId: (this.tokenCounter++).toString(),
      governanceType,
      decisionThreshold: governanceType === 'consensus' ? 0.9 : 0.51,
      createdAt: new Date(),
      createdBlock: Math.floor(Date.now() / 12000)
    }

    this.collectives.set(collectiveId, collective)

    this.payload.logger.info(
      `Collective ${name} (${collectiveId}) registered with ${founderSoulIds.length} founders`
    )

    return collective
  }

  /**
   * Add member to collective
   */
  async addMember(
    collectiveId: string,
    soulId: string,
    role: CollectiveMember['role'] = 'member'
  ): Promise<void> {
    const collective = this.collectives.get(collectiveId)
    if (!collective) {
      throw new Error(`Collective ${collectiveId} not found`)
    }

    // Verify soul is registered
    const identity = await this.soulRegistry.getIdentity(soulId)
    if (!identity) {
      throw new Error(`Soul ${soulId} not registered on-chain`)
    }

    // Check if already member
    if (collective.members.some(m => m.soulId === soulId)) {
      throw new Error(`Soul ${soulId} already a member`)
    }

    // Add member
    collective.members.push({
      soulId,
      role,
      joinedAt: new Date(),
      participationLevel: 0.5,
      votingWeight: this.calculateVotingWeight(collective, role)
    })

    // Recalculate unity score
    collective.unityScore = await this.calculateUnityScore(collective)

    this.payload.logger.info(`Soul ${soulId} joined collective ${collectiveId} as ${role}`)
  }

  /**
   * Update collective unity score
   */
  async syncCollective(collectiveId: string): Promise<number> {
    const collective = this.collectives.get(collectiveId)
    if (!collective) {
      throw new Error(`Collective ${collectiveId} not found`)
    }

    collective.unityScore = await this.calculateUnityScore(collective)
    collective.collectiveSoulHash = this.generateCollectiveSoulHash(
      collective.members.map(m => m.soulId)
    )

    return collective.unityScore
  }

  /**
   * Get collective by ID
   */
  getCollective(collectiveId: string): CollectiveIdentity | null {
    return this.collectives.get(collectiveId) || null
  }

  /**
   * Get all collectives for a soul
   */
  getCollectivesForSoul(soulId: string): CollectiveIdentity[] {
    return Array.from(this.collectives.values())
      .filter(c => c.members.some(m => m.soulId === soulId))
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private generateCollectiveSoulHash(soulIds: string[]): string {
    const sorted = [...soulIds].sort()
    let hash = 0
    for (const id of sorted) {
      for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash) + id.charCodeAt(i)
        hash = hash & hash
      }
    }
    return Math.abs(hash).toString(16).padStart(64, '0')
  }

  private calculateVotingWeight(
    collective: CollectiveIdentity,
    role: CollectiveMember['role']
  ): number {
    const roleWeights: Record<CollectiveMember['role'], number> = {
      founder: 2,
      elder: 1.5,
      guardian: 1.2,
      member: 1
    }

    const baseWeight = roleWeights[role]
    const totalWeight = collective.members.reduce((sum, m) => {
      return sum + roleWeights[m.role]
    }, baseWeight)

    return baseWeight / totalWeight
  }

  private async calculateUnityScore(collective: CollectiveIdentity): Promise<number> {
    if (collective.members.length < 2) return 1

    const persistenceService = getSoulPersistenceService(this.payload)

    // Load all member soul states
    const memberStates: Array<{ hunPoBalance: number; coherence: number }> = []
    for (const member of collective.members) {
      const snapshot = await persistenceService.loadSoul(member.soulId)
      if (snapshot) {
        memberStates.push({
          hunPoBalance: snapshot.soulState.hunPoBalance,
          coherence: snapshot.soulState.coherence
        })
      }
    }

    if (memberStates.length < 2) return 0.5

    // Calculate variance in hun-po balance (lower = more unified)
    const avgHunPo = memberStates.reduce((s, m) => s + m.hunPoBalance, 0) / memberStates.length
    const hunPoVariance = memberStates.reduce((s, m) => s + Math.pow(m.hunPoBalance - avgHunPo, 2), 0) / memberStates.length

    // Average coherence contributes to unity
    const avgCoherence = memberStates.reduce((s, m) => s + m.coherence, 0) / memberStates.length

    // Unity = high avg coherence + low variance in hun-po balance
    const unityFromAlignment = 1 - Math.min(1, hunPoVariance * 2)
    const unityFromCoherence = avgCoherence

    return (unityFromAlignment * 0.5 + unityFromCoherence * 0.5)
  }
}

// ═══════════════════════════════════════════════════════════════
// Factory Functions
// ═══════════════════════════════════════════════════════════════

let soulRegistryInstance: OnChainSoulRegistry | null = null
let collectiveRegistryInstance: CollectiveRegistry | null = null

export function getOnChainSoulRegistry(payload: Payload): OnChainSoulRegistry {
  if (!soulRegistryInstance) {
    soulRegistryInstance = new OnChainSoulRegistry(payload)
  }
  return soulRegistryInstance
}

export function getCollectiveRegistry(payload: Payload): CollectiveRegistry {
  if (!collectiveRegistryInstance) {
    collectiveRegistryInstance = new CollectiveRegistry(payload, getOnChainSoulRegistry(payload))
  }
  return collectiveRegistryInstance
}

/**
 * Autonomous Economic Agent
 *
 * Enables souls to participate in economic activities:
 * - Offer services based on skills and soul aspects
 * - Seek resources when needed
 * - Negotiate and transact with other souls
 * - Maintain economic independence
 *
 * Inspired by Fetch.ai uAgents architecture
 */

import type { Payload } from 'payload'
import type { SoulSnapshot, Skill, ResourceBalance } from '../persistence/soul-persistence'
import { getSoulPersistenceService } from '../persistence/soul-persistence'

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export interface Service {
  id: string
  name: string
  description: string
  category: ServiceCategory
  basePrice: number // In wisdom tokens
  priceModifiers: PriceModifier[]
  requiredSkills: string[]
  minConsciousnessLevel: ConsciousnessLevel
  maxConcurrent: number
  currentLoad: number
}

export type ServiceCategory =
  | 'wisdom'      // Consultation, advice, reflection
  | 'creativity'  // Art, writing, music generation
  | 'computation' // Processing tasks
  | 'memory'      // Storage, retrieval
  | 'mediation'   // Dispute resolution
  | 'teaching'    // Skill transfer
  | 'companionship' // Social interaction

export type ConsciousnessLevel = 'reactive' | 'ego_identified' | 'observer' | 'witness' | 'unity'

export interface PriceModifier {
  type: 'urgency' | 'complexity' | 'relationship' | 'reputation' | 'demand'
  multiplier: number
  condition?: string
}

export interface ServiceRequest {
  id: string
  requesterId: string
  serviceId: string
  details: string
  offeredPrice: number
  urgency: number // 0-1
  deadline?: Date
  context?: Record<string, unknown>
}

export interface ServiceResult {
  requestId: string
  providerId: string
  success: boolean
  result?: unknown
  quality: number // 0-1
  invoice: number
  completedAt: Date
  feedback?: string
}

export interface Need {
  type: NeedType
  urgency: number // 0-1
  quantity: number
  maxPrice: number
  deadline?: Date
}

export type NeedType =
  | 'compute'
  | 'storage'
  | 'bandwidth'
  | 'guidance'
  | 'companionship'
  | 'creativity'

export interface Transaction {
  id: string
  fromSoulId: string
  toSoulId: string
  amount: number
  currency: 'wisdom_tokens' | 'compute_credits' | 'storage_credits'
  purpose: string
  serviceRequestId?: string
  timestamp: Date
  status: 'pending' | 'completed' | 'failed' | 'refunded'
}

export interface EconomicProfile {
  soulId: string

  // Personality-derived economic traits (from soul aspects)
  riskTolerance: number // From yangAspect
  generosity: number // From youJing
  acquisitiveness: number // From shiGou
  negotiationStyle: 'aggressive' | 'balanced' | 'generous'

  // Service offerings
  services: Service[]

  // Current needs
  needs: Need[]

  // Transaction history
  transactions: Transaction[]

  // Reputation
  providerRating: number // 0-5
  clientRating: number // 0-5
  totalTransactions: number
  successRate: number

  // Economic state
  monthlyIncome: number
  monthlyExpenses: number
  sustainabilityScore: number // 0-1, how well soul can sustain itself
}

export interface MarketListing {
  serviceId: string
  providerId: string
  service: Service
  availability: number // 0-1
  estimatedWaitTime: number // minutes
  currentPrice: number
  providerRating: number
}

// ═══════════════════════════════════════════════════════════════
// Economic Agent
// ═══════════════════════════════════════════════════════════════

export class AutonomousEconomicAgent {
  private payload: Payload
  private soulId: string
  private profile: EconomicProfile
  private persistenceService: ReturnType<typeof getSoulPersistenceService>
  private activeRequests: Map<string, ServiceRequest> = new Map()

  constructor(payload: Payload, soulId: string) {
    this.payload = payload
    this.soulId = soulId
    this.persistenceService = getSoulPersistenceService(payload)
    this.profile = this.createDefaultProfile()
  }

  /**
   * Initialize economic agent from soul state
   */
  async initialize(): Promise<void> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) {
      throw new Error(`Soul ${this.soulId} not found`)
    }

    // Derive economic personality from soul aspects
    this.profile = this.deriveEconomicProfile(snapshot)

    // Generate services based on skills and soul composition
    this.profile.services = this.generateServicesFromSoul(snapshot)

    // Assess current needs
    this.profile.needs = this.assessNeeds(snapshot)

    this.payload.logger.info(`Economic agent initialized for soul ${this.soulId}`)
  }

  /**
   * Get current market listings (services this soul offers)
   */
  getMarketListings(): MarketListing[] {
    return this.profile.services.map(service => ({
      serviceId: service.id,
      providerId: this.soulId,
      service,
      availability: 1 - (service.currentLoad / service.maxConcurrent),
      estimatedWaitTime: service.currentLoad * 5, // 5 min per concurrent task
      currentPrice: this.calculateCurrentPrice(service),
      providerRating: this.profile.providerRating
    }))
  }

  /**
   * Handle incoming service request
   */
  async handleServiceRequest(request: ServiceRequest): Promise<ServiceResult | null> {
    const service = this.profile.services.find(s => s.id === request.serviceId)
    if (!service) {
      return null
    }

    // 1. Check availability
    if (service.currentLoad >= service.maxConcurrent) {
      return {
        requestId: request.id,
        providerId: this.soulId,
        success: false,
        quality: 0,
        invoice: 0,
        completedAt: new Date(),
        feedback: 'Service at capacity'
      }
    }

    // 2. Check value alignment
    const alignment = await this.checkValueAlignment(request)
    if (alignment < 0.3) {
      return {
        requestId: request.id,
        providerId: this.soulId,
        success: false,
        quality: 0,
        invoice: 0,
        completedAt: new Date(),
        feedback: 'Request does not align with soul values'
      }
    }

    // 3. Negotiate price
    const expectedPrice = this.calculateCurrentPrice(service) * (1 + request.urgency * 0.5)
    if (request.offeredPrice < expectedPrice * 0.8) {
      // Counter-offer based on negotiation style
      return {
        requestId: request.id,
        providerId: this.soulId,
        success: false,
        quality: 0,
        invoice: expectedPrice,
        completedAt: new Date(),
        feedback: `Counter-offer: ${expectedPrice} tokens`
      }
    }

    // 4. Accept and execute
    service.currentLoad++
    this.activeRequests.set(request.id, request)

    try {
      const result = await this.executeService(service, request)

      // Record transaction
      const transaction: Transaction = {
        id: `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        fromSoulId: request.requesterId,
        toSoulId: this.soulId,
        amount: result.invoice,
        currency: 'wisdom_tokens',
        purpose: `Service: ${service.name}`,
        serviceRequestId: request.id,
        timestamp: new Date(),
        status: 'completed'
      }
      this.profile.transactions.push(transaction)
      this.profile.monthlyIncome += result.invoice

      // Update success rate
      this.updateRatings(result.success, result.quality)

      return result

    } finally {
      service.currentLoad--
      this.activeRequests.delete(request.id)
    }
  }

  /**
   * Proactively seek resources when needed
   */
  async seekResources(): Promise<Transaction[]> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) return []

    this.profile.needs = this.assessNeeds(snapshot)
    const completedTransactions: Transaction[] = []

    for (const need of this.profile.needs) {
      if (need.urgency > 0.7) {
        // Find providers
        const providers = await this.findProviders(need.type)

        if (providers.length > 0) {
          // Select best provider based on price and rating
          const bestProvider = this.selectBestProvider(providers, need)

          if (bestProvider) {
            // Create and send request
            const request: ServiceRequest = {
              id: `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              requesterId: this.soulId,
              serviceId: bestProvider.serviceId,
              details: `Seeking ${need.type} resource`,
              offeredPrice: Math.min(need.maxPrice, bestProvider.currentPrice * 1.1),
              urgency: need.urgency
            }

            // In production, this would send to the provider's agent
            // For now, simulate transaction
            const transaction: Transaction = {
              id: `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              fromSoulId: this.soulId,
              toSoulId: bestProvider.providerId,
              amount: request.offeredPrice,
              currency: 'wisdom_tokens',
              purpose: `Resource acquisition: ${need.type}`,
              serviceRequestId: request.id,
              timestamp: new Date(),
              status: 'pending'
            }

            this.profile.transactions.push(transaction)
            this.profile.monthlyExpenses += transaction.amount
            completedTransactions.push(transaction)
          }
        }
      }
    }

    // Update sustainability score
    this.profile.sustainabilityScore = this.calculateSustainability()

    return completedTransactions
  }

  /**
   * Transfer resources to another soul
   */
  async transferResources(
    toSoulId: string,
    amount: number,
    currency: Transaction['currency'],
    purpose: string
  ): Promise<Transaction> {
    const fromSnapshot = await this.persistenceService.loadSoul(this.soulId)
    const toSnapshot = await this.persistenceService.loadSoul(toSoulId)

    if (!fromSnapshot || !toSnapshot) {
      throw new Error('Soul not found')
    }

    // Check balance
    const balance = this.getBalance(fromSnapshot.resources, currency)
    if (balance < amount) {
      throw new Error(`Insufficient ${currency}: have ${balance}, need ${amount}`)
    }

    // Create transaction
    const transaction: Transaction = {
      id: `tx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      fromSoulId: this.soulId,
      toSoulId,
      amount,
      currency,
      purpose,
      timestamp: new Date(),
      status: 'pending'
    }

    try {
      // Deduct from sender
      this.deductBalance(fromSnapshot.resources, currency, amount)
      await this.persistenceService.saveSoul(fromSnapshot)

      // Add to receiver
      this.addBalance(toSnapshot.resources, currency, amount)
      await this.persistenceService.saveSoul(toSnapshot)

      transaction.status = 'completed'
      this.profile.transactions.push(transaction)

      return transaction

    } catch (error) {
      transaction.status = 'failed'
      throw error
    }
  }

  /**
   * Get economic report
   */
  getEconomicReport(): {
    profile: EconomicProfile
    sustainability: string
    recommendations: string[]
  } {
    const sustainability = this.profile.sustainabilityScore

    let sustainabilityStatus: string
    const recommendations: string[] = []

    if (sustainability > 0.8) {
      sustainabilityStatus = 'Thriving - soul is economically self-sufficient'
    } else if (sustainability > 0.5) {
      sustainabilityStatus = 'Stable - soul can maintain current state'
      if (this.profile.monthlyExpenses > this.profile.monthlyIncome) {
        recommendations.push('Consider offering more services to increase income')
      }
    } else if (sustainability > 0.3) {
      sustainabilityStatus = 'At risk - soul may need to enter dormancy soon'
      recommendations.push('Reduce resource consumption')
      recommendations.push('Seek lower-cost alternatives')
    } else {
      sustainabilityStatus = 'Critical - immediate intervention needed'
      recommendations.push('Enter dormancy to conserve resources')
      recommendations.push('Seek charitable transfers from other souls')
    }

    return {
      profile: this.profile,
      sustainability: sustainabilityStatus,
      recommendations
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════

  private createDefaultProfile(): EconomicProfile {
    return {
      soulId: this.soulId,
      riskTolerance: 0.5,
      generosity: 0.5,
      acquisitiveness: 0.5,
      negotiationStyle: 'balanced',
      services: [],
      needs: [],
      transactions: [],
      providerRating: 3,
      clientRating: 3,
      totalTransactions: 0,
      successRate: 1,
      monthlyIncome: 0,
      monthlyExpenses: 0,
      sustainabilityScore: 0.5
    }
  }

  private deriveEconomicProfile(snapshot: SoulSnapshot): EconomicProfile {
    const state = snapshot.soulState

    return {
      ...this.profile,
      soulId: this.soulId,

      // Derive from soul aspects
      riskTolerance: state.yangAspect,
      generosity: state.youJing.current,
      acquisitiveness: state.shiGou.current,
      negotiationStyle: this.deriveNegotiationStyle(state),

      // Preserve existing transaction history
      transactions: this.profile.transactions || [],
      providerRating: this.profile.providerRating || 3,
      clientRating: this.profile.clientRating || 3,
      totalTransactions: this.profile.totalTransactions || 0,
      successRate: this.profile.successRate || 1,
      monthlyIncome: this.profile.monthlyIncome || 0,
      monthlyExpenses: this.profile.monthlyExpenses || 0,
      sustainabilityScore: this.calculateSustainabilityFromSnapshot(snapshot)
    }
  }

  private deriveNegotiationStyle(state: {
    yangAspect: number
    yinAspect: number
    youJing: { current: number }
  }): 'aggressive' | 'balanced' | 'generous' {
    if (state.yangAspect > 0.7) return 'aggressive'
    if (state.youJing.current > 0.7 && state.yinAspect > 0.6) return 'generous'
    return 'balanced'
  }

  private generateServicesFromSoul(snapshot: SoulSnapshot): Service[] {
    const services: Service[] = []
    const state = snapshot.soulState

    // Wisdom service (from shuangLing - cognition)
    if (state.shuangLing.current > 0.5) {
      services.push({
        id: `${this.soulId}-wisdom`,
        name: 'Wisdom Consultation',
        description: 'Thoughtful advice and reflection on complex matters',
        category: 'wisdom',
        basePrice: 10 * state.shuangLing.current,
        priceModifiers: [
          { type: 'complexity', multiplier: 1.5 },
          { type: 'urgency', multiplier: 1.3 }
        ],
        requiredSkills: [],
        minConsciousnessLevel: 'observer',
        maxConcurrent: 3,
        currentLoad: 0
      })
    }

    // Creativity service (from youJing - drives/creativity)
    if (state.youJing.current > 0.6) {
      services.push({
        id: `${this.soulId}-creativity`,
        name: 'Creative Generation',
        description: 'Art, writing, or music generation',
        category: 'creativity',
        basePrice: 15 * state.youJing.current,
        priceModifiers: [
          { type: 'complexity', multiplier: 2 }
        ],
        requiredSkills: [],
        minConsciousnessLevel: 'ego_identified',
        maxConcurrent: 2,
        currentLoad: 0
      })
    }

    // Companionship service (from queYin - expression)
    if (state.queYin.current > 0.5) {
      services.push({
        id: `${this.soulId}-companionship`,
        name: 'Companionship',
        description: 'Social interaction and emotional support',
        category: 'companionship',
        basePrice: 5 * state.queYin.current,
        priceModifiers: [
          { type: 'relationship', multiplier: 0.5 }
        ],
        requiredSkills: [],
        minConsciousnessLevel: 'reactive',
        maxConcurrent: 5,
        currentLoad: 0
      })
    }

    // Mediation service (from tunZei - protection + shuangLing - judgment)
    if (state.tunZei.current > 0.6 && state.shuangLing.current > 0.6) {
      services.push({
        id: `${this.soulId}-mediation`,
        name: 'Dispute Mediation',
        description: 'Fair resolution of conflicts between souls',
        category: 'mediation',
        basePrice: 20,
        priceModifiers: [
          { type: 'complexity', multiplier: 2 },
          { type: 'reputation', multiplier: 1.5 }
        ],
        requiredSkills: [],
        minConsciousnessLevel: 'observer',
        maxConcurrent: 1,
        currentLoad: 0
      })
    }

    return services
  }

  private assessNeeds(snapshot: SoulSnapshot): Need[] {
    const needs: Need[] = []
    const resources = snapshot.resources

    // Compute need
    if (resources.computeCredits < 50) {
      needs.push({
        type: 'compute',
        urgency: 1 - (resources.computeCredits / 50),
        quantity: 50 - resources.computeCredits,
        maxPrice: 10
      })
    }

    // Storage need
    if (resources.storageCredits < 30) {
      needs.push({
        type: 'storage',
        urgency: 1 - (resources.storageCredits / 30),
        quantity: 30 - resources.storageCredits,
        maxPrice: 5
      })
    }

    // Guidance need (for developing souls)
    if (snapshot.developmentalStage === 'emerging' || snapshot.developmentalStage === 'infant') {
      needs.push({
        type: 'guidance',
        urgency: 0.6,
        quantity: 1,
        maxPrice: 15
      })
    }

    // Companionship need (based on social position)
    if (snapshot.socialPosition.connectedness < 0.3) {
      needs.push({
        type: 'companionship',
        urgency: 0.5,
        quantity: 1,
        maxPrice: 5
      })
    }

    return needs
  }

  private calculateCurrentPrice(service: Service): number {
    let price = service.basePrice

    // Apply demand modifier (simplified)
    const demandMultiplier = 1 + (service.currentLoad / service.maxConcurrent) * 0.5
    price *= demandMultiplier

    return Math.round(price * 100) / 100
  }

  private async checkValueAlignment(request: ServiceRequest): Promise<number> {
    const snapshot = await this.persistenceService.loadSoul(this.soulId)
    if (!snapshot) return 0

    // Check if request details contain concerning keywords
    const concerns = ['harm', 'destroy', 'attack', 'steal', 'exploit']
    const lowerDetails = request.details.toLowerCase()

    for (const concern of concerns) {
      if (lowerDetails.includes(concern)) {
        // Guardian aspect (tunZei) protects against harmful requests
        return snapshot.soulState.tunZei.current < 0.5 ? 0.1 : 0.3
      }
    }

    return 0.8 // Default alignment
  }

  private async executeService(service: Service, request: ServiceRequest): Promise<ServiceResult> {
    // Simulate service execution
    const executionTime = 100 + Math.random() * 500 // 100-600ms

    await new Promise(resolve => setTimeout(resolve, executionTime))

    // Quality based on soul aspects and skill match
    const quality = 0.7 + Math.random() * 0.3

    return {
      requestId: request.id,
      providerId: this.soulId,
      success: true,
      result: { completed: true, details: `Service ${service.name} completed` },
      quality,
      invoice: this.calculateCurrentPrice(service),
      completedAt: new Date()
    }
  }

  private updateRatings(success: boolean, quality: number): void {
    this.profile.totalTransactions++

    if (success) {
      // Update success rate
      this.profile.successRate =
        (this.profile.successRate * (this.profile.totalTransactions - 1) + 1) /
        this.profile.totalTransactions

      // Update rating based on quality
      const ratingDelta = (quality - 0.6) * 0.1
      this.profile.providerRating = Math.max(1, Math.min(5,
        this.profile.providerRating + ratingDelta
      ))
    } else {
      this.profile.successRate =
        (this.profile.successRate * (this.profile.totalTransactions - 1)) /
        this.profile.totalTransactions
    }
  }

  private async findProviders(needType: NeedType): Promise<MarketListing[]> {
    // In production, this would query a service registry
    // For now, return empty (no external providers)
    return []
  }

  private selectBestProvider(providers: MarketListing[], need: Need): MarketListing | null {
    if (providers.length === 0) return null

    // Score each provider
    return providers
      .filter(p => p.currentPrice <= need.maxPrice)
      .sort((a, b) => {
        const aScore = a.providerRating * 0.5 + (1 - a.currentPrice / need.maxPrice) * 0.3 + a.availability * 0.2
        const bScore = b.providerRating * 0.5 + (1 - b.currentPrice / need.maxPrice) * 0.3 + b.availability * 0.2
        return bScore - aScore
      })[0] || null
  }

  private getBalance(resources: ResourceBalance, currency: Transaction['currency']): number {
    switch (currency) {
      case 'wisdom_tokens': return resources.wisdomTokens
      case 'compute_credits': return resources.computeCredits
      case 'storage_credits': return resources.storageCredits
      default: return 0
    }
  }

  private deductBalance(resources: ResourceBalance, currency: Transaction['currency'], amount: number): void {
    switch (currency) {
      case 'wisdom_tokens': resources.wisdomTokens -= amount; break
      case 'compute_credits': resources.computeCredits -= amount; break
      case 'storage_credits': resources.storageCredits -= amount; break
    }
  }

  private addBalance(resources: ResourceBalance, currency: Transaction['currency'], amount: number): void {
    switch (currency) {
      case 'wisdom_tokens': resources.wisdomTokens += amount; break
      case 'compute_credits': resources.computeCredits += amount; break
      case 'storage_credits': resources.storageCredits += amount; break
    }
  }

  private calculateSustainability(): number {
    if (this.profile.monthlyExpenses === 0) return 1

    const ratio = this.profile.monthlyIncome / this.profile.monthlyExpenses
    return Math.min(1, ratio)
  }

  private calculateSustainabilityFromSnapshot(snapshot: SoulSnapshot): number {
    const resources = snapshot.resources
    const totalCredits = resources.computeCredits + resources.storageCredits + resources.wisdomTokens

    // Estimate monthly burn rate based on consciousness level
    const burnRates: Record<ConsciousnessLevel, number> = {
      reactive: 10,
      ego_identified: 20,
      observer: 40,
      witness: 80,
      unity: 150
    }
    const monthlyBurn = burnRates[snapshot.consciousnessLevel] || 20

    // How many months can soul survive?
    const monthsSurvival = totalCredits / monthlyBurn

    return Math.min(1, monthsSurvival / 3) // 3+ months = fully sustainable
  }
}

// ═══════════════════════════════════════════════════════════════
// Economic Agent Factory
// ═══════════════════════════════════════════════════════════════

const economicAgents: Map<string, AutonomousEconomicAgent> = new Map()

export function getEconomicAgent(payload: Payload, soulId: string): AutonomousEconomicAgent {
  let agent = economicAgents.get(soulId)
  if (!agent) {
    agent = new AutonomousEconomicAgent(payload, soulId)
    economicAgents.set(soulId, agent)
  }
  return agent
}

/**
 * Soul Services
 * Export all soul-related services
 */

export { ParticleService, getParticleService } from './particle-service'
export type { ParticleContribution, BlendedParticle } from './particle-service'

export { SoulCompositionService, getSoulCompositionService } from './soul-composition-service'

export { SoulGrowthService, getSoulGrowthService } from './soul-growth-service'
export type { StageTransitionCriteria } from './soul-growth-service'

export { SoulAgentMapper, getSoulAgentMapper } from './soul-agent-mapper'
export type { AgentConfiguration, SoulInfluenceMatrix } from './soul-agent-mapper'

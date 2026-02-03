/**
 * Advanced Bot Memory System
 * Export all memory components
 */

// Types
export * from './types'

// Services
export { getWorkingMemoryService, WorkingMemoryService } from './working-memory'
export { getConsolidationEngine, MemoryConsolidationEngine } from './consolidation-engine'
export { getCulturalEvolutionEngine, CulturalEvolutionEngine } from './cultural-evolution'
export { getPersonalizedForgettingEngine, PersonalizedForgettingEngine } from './personalized-forgetting'
export { getMultiAgentComposer, MultiAgentComposer } from './multi-agent-composition'
export { getCreativeSynthesisEngine, CreativeSynthesisEngine } from './creative-synthesis'
export { getConsciousnessEmergenceEngine, ConsciousnessEmergenceEngine } from './consciousness-emergence'
export { getSocietyFormationEngine, SocietyFormationEngine } from './society-formation'

// Initialization
export { initializeDefaultCultures } from './init-cultures'

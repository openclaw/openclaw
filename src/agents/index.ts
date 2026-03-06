/**
 * OpenClaw Local Model Fallback and Semantic Cache Integration
 *
 * This module provides:
 * 1. Local Model Fallback - Automatic fallback to Ollama/LM Studio when cloud APIs fail
 * 2. Semantic Cache Store - Caching system with embeddings and cosine similarity
 */

// Local Model Fallback exports
export {
  resolveLocalModelConfig,
  checkLocalModelHealth,
  shouldTriggerLocalFallback,
  createLocalModelStreamFn,
  runWithLocalModelFallback,
  type LocalModelConfig,
  type LocalFallbackOptions,
  type HealthStatus,
} from "./local-model-fallback.js";

// Semantic Cache exports
export {
  SemanticCacheStore,
  createSemanticCacheStore,
  resolveSemanticCacheConfig,
  cosineSimilarity,
  type SemanticCacheEntry,
  type SemanticCacheConfig,
  type CacheSearchResult,
} from "./semantic-cache-store.js";

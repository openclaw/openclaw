/**
 * Performance Monitoring & Optimization Utilities
 * Tracks and optimizes application performance metrics
 */

import type { Payload } from 'payload'

export interface PerformanceMetric {
  name: string
  duration: number
  timestamp: number
  metadata?: Record<string, any>
}

export class PerformanceMonitor {
  private payload: Payload
  private metrics: PerformanceMetric[]
  private timers: Map<string, number>
  private readonly maxMetrics: number = 1000

  constructor(payload: Payload) {
    this.payload = payload
    this.metrics = []
    this.timers = new Map()
  }

  /**
   * Start timing an operation
   */
  start(operationName: string): void {
    this.timers.set(operationName, performance.now())
  }

  /**
   * End timing and record metric
   */
  end(operationName: string, metadata?: Record<string, any>): number {
    const startTime = this.timers.get(operationName)
    if (!startTime) {
      this.payload.logger.warn(`No start time found for operation: ${operationName}`)
      return 0
    }

    const duration = performance.now() - startTime
    this.timers.delete(operationName)

    this.recordMetric({
      name: operationName,
      duration,
      timestamp: Date.now(),
      metadata
    })

    // Log slow operations
    if (duration > 1000) {
      this.payload.logger.warn(`Slow operation detected: ${operationName} took ${duration.toFixed(2)}ms`)
    }

    return duration
  }

  /**
   * Record a performance metric
   */
  recordMetric(metric: PerformanceMetric): void {
    this.metrics.push(metric)

    // Keep only recent metrics
    if (this.metrics.length > this.maxMetrics) {
      this.metrics = this.metrics.slice(-this.maxMetrics)
    }
  }

  /**
   * Get performance statistics
   */
  getStats(operationName?: string): {
    count: number
    avg: number
    min: number
    max: number
    p50: number
    p95: number
    p99: number
  } {
    const relevantMetrics = operationName
      ? this.metrics.filter(m => m.name === operationName)
      : this.metrics

    if (relevantMetrics.length === 0) {
      return {
        count: 0,
        avg: 0,
        min: 0,
        max: 0,
        p50: 0,
        p95: 0,
        p99: 0
      }
    }

    const durations = relevantMetrics.map(m => m.duration).sort((a, b) => a - b)
    const sum = durations.reduce((a, b) => a + b, 0)

    return {
      count: durations.length,
      avg: sum / durations.length,
      min: durations[0],
      max: durations[durations.length - 1],
      p50: durations[Math.floor(durations.length * 0.5)],
      p95: durations[Math.floor(durations.length * 0.95)],
      p99: durations[Math.floor(durations.length * 0.99)]
    }
  }

  /**
   * Get slow operations (above threshold)
   */
  getSlowOperations(thresholdMs: number = 1000): PerformanceMetric[] {
    return this.metrics
      .filter(m => m.duration > thresholdMs)
      .sort((a, b) => b.duration - a.duration)
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics = []
    this.timers.clear()
  }

  /**
   * Export metrics for analysis
   */
  exportMetrics(): PerformanceMetric[] {
    return [...this.metrics]
  }
}

/**
 * Database Query Performance Monitor
 * Tracks slow database queries
 */
export class DatabaseMonitor {
  private payload: Payload
  private slowQueries: Array<{
    collection: string
    operation: string
    duration: number
    timestamp: number
  }>

  constructor(payload: Payload) {
    this.payload = payload
    this.slowQueries = []
  }

  /**
   * Wrap a database operation with monitoring
   */
  async monitor<T>(
    collection: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now()

    try {
      const result = await fn()
      const duration = performance.now() - startTime

      // Log slow queries (> 500ms)
      if (duration > 500) {
        this.slowQueries.push({
          collection,
          operation,
          duration,
          timestamp: Date.now()
        })

        this.payload.logger.warn(
          `Slow database query: ${collection}.${operation} took ${duration.toFixed(2)}ms`
        )
      }

      return result
    } catch (error) {
      const duration = performance.now() - startTime
      this.payload.logger.error(
        `Database query failed: ${collection}.${operation} failed after ${duration.toFixed(2)}ms`
      )
      throw error
    }
  }

  /**
   * Get slow queries report
   */
  getSlowQueries(): typeof this.slowQueries {
    return [...this.slowQueries]
  }

  /**
   * Get queries grouped by collection
   */
  getQueriesByCollection(): Map<string, number> {
    const byCollection = new Map<string, number>()

    for (const query of this.slowQueries) {
      byCollection.set(query.collection, (byCollection.get(query.collection) || 0) + 1)
    }

    return byCollection
  }
}

/**
 * Caching Performance Monitor
 * Tracks cache hit/miss ratios
 */
export class CacheMonitor {
  private hits: number = 0
  private misses: number = 0
  private evictions: number = 0

  recordHit(): void {
    this.hits++
  }

  recordMiss(): void {
    this.misses++
  }

  recordEviction(): void {
    this.evictions++
  }

  getStats(): {
    hits: number
    misses: number
    evictions: number
    hitRate: number
    totalRequests: number
  } {
    const totalRequests = this.hits + this.misses

    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: totalRequests > 0 ? this.hits / totalRequests : 0,
      totalRequests
    }
  }

  reset(): void {
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }
}

/**
 * Singleton instances
 */
let performanceMonitor: PerformanceMonitor | null = null
let databaseMonitor: DatabaseMonitor | null = null
let cacheMonitor: CacheMonitor | null = null

export function getPerformanceMonitor(payload: Payload): PerformanceMonitor {
  if (!performanceMonitor) {
    performanceMonitor = new PerformanceMonitor(payload)
  }
  return performanceMonitor
}

export function getDatabaseMonitor(payload: Payload): DatabaseMonitor {
  if (!databaseMonitor) {
    databaseMonitor = new DatabaseMonitor(payload)
  }
  return databaseMonitor
}

export function getCacheMonitor(): CacheMonitor {
  if (!cacheMonitor) {
    cacheMonitor = new CacheMonitor()
  }
  return cacheMonitor
}

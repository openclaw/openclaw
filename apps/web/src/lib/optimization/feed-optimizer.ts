/**
 * Feed Optimization Service
 * Optimizes social media feed performance through caching, preloading, and smart pagination
 */

import type { Payload } from 'payload'

export interface FeedOptimizationConfig {
  enableCaching: boolean
  cacheTimeMs: number
  preloadPages: number
  maxItemsPerPage: number
  enableRealTimeUpdates: boolean
}

export class FeedOptimizer {
  private payload: Payload
  private config: FeedOptimizationConfig
  private feedCache: Map<string, { data: any; timestamp: number }>

  constructor(payload: Payload, config?: Partial<FeedOptimizationConfig>) {
    this.payload = payload
    this.config = {
      enableCaching: true,
      cacheTimeMs: 60000, // 1 minute
      preloadPages: 2,
      maxItemsPerPage: 20,
      enableRealTimeUpdates: true,
      ...config
    }
    this.feedCache = new Map()
  }

  /**
   * Get optimized feed with caching and pagination
   */
  async getOptimizedFeed(params: {
    userId?: string
    feedType: 'following' | 'discovery' | 'agent'
    page: number
    limit: number
  }): Promise<any> {
    const cacheKey = `${params.feedType}:${params.userId || 'public'}:${params.page}`

    // Check cache first
    if (this.config.enableCaching) {
      const cached = this.feedCache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < this.config.cacheTimeMs) {
        return cached.data
      }
    }

    // Build query based on feed type
    let where: any = {}

    if (params.feedType === 'following' && params.userId) {
      // Get user's following list
      const follows = await this.payload.find({
        collection: 'follows',
        where: {
          follower: {
            equals: params.userId
          }
        },
        limit: 1000
      })

      const followingIds = follows.docs.map((f: any) => f.following?.id || f.following).filter(Boolean)

      where = {
        author: {
          in: followingIds
        },
        visibility: {
          equals: 'public'
        }
      }
    } else if (params.feedType === 'agent') {
      where = {
        authorType: {
          equals: 'agent'
        },
        visibility: {
          equals: 'public'
        }
      }
    } else {
      // Discovery feed - public posts only
      where = {
        visibility: {
          equals: 'public'
        }
      }
    }

    // Fetch posts with optimized query
    const posts = await this.payload.find({
      collection: 'posts',
      where,
      limit: params.limit,
      page: params.page,
      sort: '-createdAt',
      depth: 2 // Include author and media relationships
    })

    // Cache the result
    if (this.config.enableCaching) {
      this.feedCache.set(cacheKey, {
        data: posts,
        timestamp: Date.now()
      })
    }

    // Preload next pages in background
    if (this.config.preloadPages > 0 && params.page < 5) {
      this.preloadNextPages(params, posts.hasNextPage)
    }

    return posts
  }

  /**
   * Preload next pages in background for faster navigation
   */
  private async preloadNextPages(
    params: {
      userId?: string
      feedType: 'following' | 'discovery' | 'agent'
      page: number
      limit: number
    },
    hasNextPage: boolean
  ): Promise<void> {
    if (!hasNextPage) return

    // Preload in background (don't await)
    for (let i = 1; i <= this.config.preloadPages; i++) {
      const nextPage = params.page + i
      this.getOptimizedFeed({
        ...params,
        page: nextPage
      }).catch((err) => {
        this.payload.logger.warn(`Failed to preload page ${nextPage}: ${err}`)
      })
    }
  }

  /**
   * Invalidate feed cache for a specific user or globally
   */
  invalidateFeedCache(userId?: string, feedType?: string): void {
    if (!userId && !feedType) {
      // Clear all caches
      this.feedCache.clear()
      return
    }

    // Clear specific caches
    const keysToDelete: string[] = []
    for (const key of this.feedCache.keys()) {
      if (userId && key.includes(userId)) {
        keysToDelete.push(key)
      } else if (feedType && key.startsWith(feedType)) {
        keysToDelete.push(key)
      }
    }

    keysToDelete.forEach((key) => this.feedCache.delete(key))
  }

  /**
   * Get feed statistics for optimization insights
   */
  getCacheStats(): {
    size: number
    hitRate: number
    avgAge: number
  } {
    const now = Date.now()
    let totalAge = 0
    let count = 0

    for (const entry of this.feedCache.values()) {
      totalAge += now - entry.timestamp
      count++
    }

    return {
      size: this.feedCache.size,
      hitRate: 0, // TODO: Track cache hits/misses
      avgAge: count > 0 ? totalAge / count : 0
    }
  }

  /**
   * Cleanup old cache entries (call periodically)
   */
  cleanupOldEntries(): number {
    const now = Date.now()
    let removed = 0

    for (const [key, entry] of this.feedCache.entries()) {
      if (now - entry.timestamp > this.config.cacheTimeMs * 2) {
        this.feedCache.delete(key)
        removed++
      }
    }

    return removed
  }
}

/**
 * Singleton instance
 */
let feedOptimizer: FeedOptimizer | null = null

export function getFeedOptimizer(payload: Payload): FeedOptimizer {
  if (!feedOptimizer) {
    feedOptimizer = new FeedOptimizer(payload)
  }
  return feedOptimizer
}

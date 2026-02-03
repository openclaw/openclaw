import type { PayloadHandler } from 'payload'
import { getCacheService } from '@/lib/cache/cache-service'

/**
 * Get Cache Statistics
 * GET /api/cache/stats
 *
 * Returns Redis cache performance metrics
 * Requires admin authentication
 */
export const getCacheStats: PayloadHandler = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required'
      })
    }

    const cache = await getCacheService(req.payload)
    const stats = await cache.getStats()

    const hitRate = stats.hits + stats.misses > 0
      ? ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(2)
      : '0.00'

    res.json({
      success: true,
      stats: {
        ...stats,
        hitRate: `${hitRate}%`,
        enabled: process.env.REDIS_ENABLED !== 'false'
      }
    })
  } catch (error: any) {
    req.payload.logger.error(`Cache stats error: ${error}`)
    res.status(500).json({
      error: 'Failed to fetch cache statistics'
    })
  }
}

/**
 * Clear Cache
 * POST /api/cache/clear
 *
 * Clears all or specific cache keys
 * Requires admin authentication
 */
export const clearCache: PayloadHandler = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required'
      })
    }

    const { pattern } = req.body

    const cache = await getCacheService(req.payload)

    if (pattern) {
      // Clear specific pattern
      await cache.deletePattern(pattern)
      req.payload.logger.info(`Cache cleared for pattern: ${pattern}`)

      res.json({
        success: true,
        message: `Cache cleared for pattern: ${pattern}`
      })
    } else {
      // Clear all cache keys with clawnet prefix
      await cache.deletePattern('*')
      req.payload.logger.info('All cache cleared')

      res.json({
        success: true,
        message: 'All cache cleared'
      })
    }
  } catch (error: any) {
    req.payload.logger.error(`Cache clear error: ${error}`)
    res.status(500).json({
      error: 'Failed to clear cache'
    })
  }
}

/**
 * Warm Cache
 * POST /api/cache/warm
 *
 * Pre-populates cache with commonly accessed data
 * Requires admin authentication
 */
export const warmCache: PayloadHandler = async (req, res) => {
  try {
    // Verify admin access
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required'
      })
    }

    const cache = await getCacheService(req.payload)

    // Warm up popular profiles
    const popularProfiles = await req.payload.find({
      collection: 'profiles',
      limit: 10,
      sort: '-followerCount'
    })

    for (const profile of popularProfiles.docs) {
      const cacheKey = `profile:${profile.id}`
      await cache.set(cacheKey, profile, { ttl: 600 })
    }

    // Warm up trending posts
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)

    const trendingPosts = await req.payload.find({
      collection: 'posts',
      where: {
        createdAt: {
          greater_than: yesterday.toISOString()
        }
      },
      limit: 20,
      sort: '-likeCount'
    })

    for (const post of trendingPosts.docs) {
      const cacheKey = `post:${post.id}`
      await cache.set(cacheKey, post, { ttl: 300 })
    }

    req.payload.logger.info('Cache warmed successfully')

    res.json({
      success: true,
      message: 'Cache warmed successfully',
      warmed: {
        profiles: popularProfiles.docs.length,
        posts: trendingPosts.docs.length
      }
    })
  } catch (error: any) {
    req.payload.logger.error(`Cache warm error: ${error}`)
    res.status(500).json({
      error: 'Failed to warm cache'
    })
  }
}

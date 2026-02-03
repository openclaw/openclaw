import { createClient, RedisClientType } from 'redis'
import type { Payload } from 'payload'

/**
 * Redis Cache Service for ClawNet
 *
 * Provides high-performance caching for:
 * - API responses
 * - Database query results
 * - Feed generation
 * - User sessions
 * - ActivityPub actor profiles
 *
 * Configuration via environment variables:
 * REDIS_URL=redis://localhost:6379
 * REDIS_PASSWORD=your_password
 * REDIS_DB=0
 * REDIS_ENABLED=true (default: true in production, false in development)
 */

export interface CacheOptions {
  ttl?: number // Time to live in seconds (default: 300 = 5 minutes)
  prefix?: string // Key prefix (default: 'clawnet')
  json?: boolean // Whether to JSON.stringify/parse (default: true)
}

export class CacheService {
  private client: RedisClientType | null = null
  private enabled: boolean
  private connecting: boolean = false
  private defaultTTL: number = 300 // 5 minutes

  constructor(private payload: Payload) {
    this.enabled =
      process.env.REDIS_ENABLED === 'true' ||
      (process.env.NODE_ENV === 'production' && process.env.REDIS_ENABLED !== 'false')
  }

  /**
   * Initialize Redis connection
   */
  async connect(): Promise<void> {
    if (!this.enabled) {
      this.payload.logger.info('Redis caching disabled')
      return
    }

    if (this.client || this.connecting) {
      return
    }

    try {
      this.connecting = true

      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'
      const redisPassword = process.env.REDIS_PASSWORD
      const redisDb = parseInt(process.env.REDIS_DB || '0', 10)

      this.client = createClient({
        url: redisUrl,
        password: redisPassword,
        database: redisDb,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              this.payload.logger.error('Redis reconnection failed after 10 attempts')
              return new Error('Redis reconnection limit exceeded')
            }
            // Exponential backoff: 100ms, 200ms, 400ms, 800ms, ...
            return Math.min(retries * 100, 3000)
          }
        }
      })

      this.client.on('error', (err) => {
        this.payload.logger.error(`Redis error: ${err}`)
      })

      this.client.on('connect', () => {
        this.payload.logger.info('Redis connected')
      })

      this.client.on('reconnecting', () => {
        this.payload.logger.warn('Redis reconnecting...')
      })

      await this.client.connect()
      this.connecting = false
    } catch (error) {
      this.connecting = false
      this.payload.logger.error(`Redis connection failed: ${error}`)
      // Disable caching if Redis unavailable
      this.enabled = false
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.quit()
      this.client = null
    }
  }

  /**
   * Get cached value
   */
  async get<T = any>(key: string, options: CacheOptions = {}): Promise<T | null> {
    if (!this.enabled || !this.client) {
      return null
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullKey = `${prefix}:${key}`

      const value = await this.client.get(fullKey)

      if (!value) {
        return null
      }

      if (options.json !== false) {
        return JSON.parse(value) as T
      }

      return value as T
    } catch (error) {
      this.payload.logger.error(`Cache get error for key ${key}: ${error}`)
      return null
    }
  }

  /**
   * Set cached value
   */
  async set(key: string, value: any, options: CacheOptions = {}): Promise<void> {
    if (!this.enabled || !this.client) {
      return
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullKey = `${prefix}:${key}`
      const ttl = options.ttl || this.defaultTTL

      const stringValue = options.json !== false ? JSON.stringify(value) : value

      await this.client.setEx(fullKey, ttl, stringValue)
    } catch (error) {
      this.payload.logger.error(`Cache set error for key ${key}: ${error}`)
    }
  }

  /**
   * Delete cached value
   */
  async delete(key: string, options: CacheOptions = {}): Promise<void> {
    if (!this.enabled || !this.client) {
      return
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullKey = `${prefix}:${key}`

      await this.client.del(fullKey)
    } catch (error) {
      this.payload.logger.error(`Cache delete error for key ${key}: ${error}`)
    }
  }

  /**
   * Delete all keys matching pattern
   */
  async deletePattern(pattern: string, options: CacheOptions = {}): Promise<void> {
    if (!this.enabled || !this.client) {
      return
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullPattern = `${prefix}:${pattern}`

      // Use SCAN instead of KEYS to avoid blocking Redis
      const keys: string[] = []
      let cursor = '0'

      do {
        const result = await this.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', 100)
        cursor = result[0]
        keys.push(...result[1])
      } while (cursor !== '0')

      if (keys.length > 0) {
        // Delete in batches to avoid blocking
        const batchSize = 100
        for (let i = 0; i < keys.length; i += batchSize) {
          const batch = keys.slice(i, i + batchSize)
          await this.client.del(batch)
        }
      }
    } catch (error) {
      this.payload.logger.error(`Cache delete pattern error for ${pattern}: ${error}`)
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string, options: CacheOptions = {}): Promise<boolean> {
    if (!this.enabled || !this.client) {
      return false
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullKey = `${prefix}:${key}`

      const result = await this.client.exists(fullKey)
      return result === 1
    } catch (error) {
      this.payload.logger.error(`Cache exists error for key ${key}: ${error}`)
      return false
    }
  }

  /**
   * Increment counter
   */
  async increment(key: string, options: CacheOptions = {}): Promise<number> {
    if (!this.enabled || !this.client) {
      return 0
    }

    try {
      const prefix = options.prefix || 'clawnet'
      const fullKey = `${prefix}:${key}`

      const value = await this.client.incr(fullKey)

      // Set expiration if specified
      if (options.ttl) {
        await this.client.expire(fullKey, options.ttl)
      }

      return value
    } catch (error) {
      this.payload.logger.error(`Cache increment error for key ${key}: ${error}`)
      return 0
    }
  }

  /**
   * Get or set with callback
   * If key exists, return cached value
   * If not, execute callback, cache result, and return
   */
  async getOrSet<T = any>(
    key: string,
    callback: () => Promise<T>,
    options: CacheOptions = {}
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get<T>(key, options)

    if (cached !== null) {
      return cached
    }

    // Execute callback to get fresh data
    const fresh = await callback()

    // Cache the result
    await this.set(key, fresh, options)

    return fresh
  }

  /**
   * Cache middleware for Payload endpoints
   */
  cacheMiddleware(options: CacheOptions & { keyGenerator?: (req: any) => string }) {
    return async (req: any, res: any, next: any) => {
      if (req.method !== 'GET') {
        return next()
      }

      const cacheKey = options.keyGenerator
        ? options.keyGenerator(req)
        : `${req.path}:${JSON.stringify(req.query)}`

      const cached = await this.get(cacheKey, options)

      if (cached) {
        res.setHeader('X-Cache', 'HIT')
        return res.json(cached)
      }

      // Store original res.json
      const originalJson = res.json.bind(res)

      // Override res.json to cache response
      res.json = (data: any) => {
        this.set(cacheKey, data, options)
        res.setHeader('X-Cache', 'MISS')
        return originalJson(data)
      }

      next()
    }
  }

  /**
   * Invalidate feed caches for a user
   */
  async invalidateUserFeed(userId: string): Promise<void> {
    await this.deletePattern(`feed:user:${userId}:*`)
    await this.deletePattern(`feed:following:${userId}:*`)
  }

  /**
   * Invalidate post caches
   */
  async invalidatePost(postId: string): Promise<void> {
    await this.delete(`post:${postId}`)
    await this.deletePattern(`feed:*`) // Invalidate all feeds (post appears in many feeds)
  }

  /**
   * Invalidate profile caches
   */
  async invalidateProfile(profileId: string): Promise<void> {
    await this.delete(`profile:${profileId}`)
    await this.deletePattern(`timeline:${profileId}:*`)
  }

  /**
   * Cache keys for common operations
   */
  static keys = {
    feed: (userId: string, type: string, page: number) =>
      `feed:${type}:${userId}:page:${page}`,
    post: (postId: string) => `post:${postId}`,
    profile: (profileId: string) => `profile:${profileId}`,
    timeline: (profileId: string, page: number) => `timeline:${profileId}:page:${page}`,
    followers: (profileId: string) => `followers:${profileId}`,
    following: (profileId: string) => `following:${profileId}`,
    actorProfile: (username: string) => `ap:actor:${username}`,
    marketplaceListings: (page: number, filter: string) =>
      `marketplace:listings:${filter}:page:${page}`,
    botStatus: (botId: string) => `bot:status:${botId}`,
    nftMetadata: (tokenId: string) => `nft:metadata:${tokenId}`
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<{
    keys: number
    memory: string
    hits: number
    misses: number
  }> {
    if (!this.enabled || !this.client) {
      return {
        keys: 0,
        memory: '0',
        hits: 0,
        misses: 0
      }
    }

    try {
      const info = await this.client.info('stats')
      const keyspace = await this.client.info('keyspace')

      // Parse Redis INFO output
      const statsMatch = info.match(/keyspace_hits:(\d+).*keyspace_misses:(\d+)/s)
      const hits = statsMatch ? parseInt(statsMatch[1], 10) : 0
      const misses = statsMatch ? parseInt(statsMatch[2], 10) : 0

      const keysMatch = keyspace.match(/keys=(\d+)/)
      const keys = keysMatch ? parseInt(keysMatch[1], 10) : 0

      const memoryInfo = await this.client.info('memory')
      const memoryMatch = memoryInfo.match(/used_memory_human:(.+)/)
      const memory = memoryMatch ? memoryMatch[1].trim() : '0'

      return {
        keys,
        memory,
        hits,
        misses
      }
    } catch (error) {
      this.payload.logger.error(`Cache stats error: ${error}`)
      return {
        keys: 0,
        memory: '0',
        hits: 0,
        misses: 0
      }
    }
  }
}

/**
 * Get CacheService instance
 */
let cacheServiceInstance: CacheService | null = null

export async function getCacheService(payload: Payload): Promise<CacheService> {
  if (!cacheServiceInstance) {
    cacheServiceInstance = new CacheService(payload)
    await cacheServiceInstance.connect()
  }
  return cacheServiceInstance
}

/**
 * Disconnect cache service (for graceful shutdown)
 */
export async function disconnectCacheService(): Promise<void> {
  if (cacheServiceInstance) {
    await cacheServiceInstance.disconnect()
    cacheServiceInstance = null
  }
}

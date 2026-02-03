import type { PayloadHandler } from 'payload'

/**
 * Bot Ownership Authorization Middleware
 * Verifies that the authenticated user owns the bot they're trying to access/modify
 *
 * Usage: Place after authenticate middleware
 * Expects botId in req.body or req.query or req.params
 */
export const authorizeBotOwnership: PayloadHandler = async (req, res, next) => {
  try {
    // User must be authenticated
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required'
      })
    }

    // Get botId from various sources
    const botId =
      req.body?.botId ||
      req.query?.botId ||
      req.params?.botId ||
      req.params?.id

    if (!botId) {
      return res.status(400).json({
        error: 'Bot ID required'
      })
    }

    // Fetch bot from database
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId as string
    })

    if (!bot) {
      return res.status(404).json({
        error: 'Bot not found'
      })
    }

    // Check ownership
    // Assuming bot has a 'user' or 'owner' field referencing the Users collection
    const botOwner = typeof bot.user === 'string' ? bot.user : bot.user?.id

    if (botOwner !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not own this bot'
      })
    }

    // Attach bot to request for downstream handlers
    // @ts-ignore
    req.bot = bot

    next()
  } catch (error) {
    req.payload.logger.error(`Authorization error: ${error}`)
    return res.status(500).json({
      error: 'Internal server error'
    })
  }
}

/**
 * Profile Ownership Authorization Middleware
 * Verifies that the authenticated user owns the profile they're trying to modify
 */
export const authorizeProfileOwnership: PayloadHandler = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required'
      })
    }

    const profileId =
      req.body?.profileId ||
      req.query?.profileId ||
      req.params?.profileId ||
      req.params?.id

    if (!profileId) {
      return res.status(400).json({
        error: 'Profile ID required'
      })
    }

    const profile = await req.payload.findByID({
      collection: 'profiles',
      id: profileId as string
    })

    if (!profile) {
      return res.status(404).json({
        error: 'Profile not found'
      })
    }

    // Check if this profile belongs to the authenticated user
    const profileOwner =
      typeof profile.user === 'string' ? profile.user : profile.user?.id

    if (profileOwner !== req.user.id) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not own this profile'
      })
    }

    // @ts-ignore
    req.profile = profile

    next()
  } catch (error) {
    req.payload.logger.error(`Profile authorization error: ${error}`)
    return res.status(500).json({
      error: 'Internal server error'
    })
  }
}

/**
 * Rate Limit Middleware Factory
 * Creates rate limiters for different operations
 */
export function createRateLimiter(options: {
  windowMs: number
  max: number
  message?: string
}): PayloadHandler {
  const requests = new Map<string, number[]>()

  return (req, res, next) => {
    const identifier = req.user?.id || req.ip || 'anonymous'
    const now = Date.now()
    const windowStart = now - options.windowMs

    // Get user's request history
    const userRequests = requests.get(identifier) || []

    // Filter to only requests within the time window
    const recentRequests = userRequests.filter((time) => time > windowStart)

    // Check if limit exceeded
    if (recentRequests.length >= options.max) {
      return res.status(429).json({
        error: 'Too many requests',
        message:
          options.message ||
          `Please wait before making more requests. Limit: ${options.max} per ${options.windowMs / 1000}s`,
        retryAfter: Math.ceil(
          (recentRequests[0] + options.windowMs - now) / 1000
        )
      })
    }

    // Add current request
    recentRequests.push(now)
    requests.set(identifier, recentRequests)

    // Clean up old entries periodically
    if (Math.random() < 0.01) {
      // 1% chance to clean
      for (const [key, times] of requests.entries()) {
        const filtered = times.filter((time) => time > windowStart)
        if (filtered.length === 0) {
          requests.delete(key)
        } else {
          requests.set(key, filtered)
        }
      }
    }

    next()
  }
}

/**
 * Pre-configured rate limiters for different operations
 */

// Blockchain operations (expensive, limited to 10 per 15 minutes)
export const blockchainRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: 'Too many blockchain operations. Please wait before trying again.'
})

// Social posting (moderate, 30 per hour)
export const postingRateLimit = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  message: 'Posting limit reached. Please wait before creating more posts.'
})

// General API (generous, 100 per minute)
export const generalRateLimit = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Too many requests. Please slow down.'
})

// Federation operations (moderate, 50 per 5 minutes)
export const federationRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50,
  message:
    'Too many federation operations. Please wait before sending more activities.'
})

// Social actions (likes, follows, comments - moderate, 50 per 5 minutes)
export const socialActionRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50,
  message: 'Too many social actions. Please wait before trying again.'
})

// Bot management operations (creating, updating, deleting bots - limited, 20 per 15 minutes)
export const botManagementRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: 'Too many bot management operations. Please wait before trying again.'
})

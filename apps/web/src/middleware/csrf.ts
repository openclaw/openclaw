import type { PayloadHandler } from 'payload'
import { createHash, randomBytes } from 'node:crypto'

/**
 * CSRF Protection Middleware
 * Protects against Cross-Site Request Forgery attacks
 *
 * Implementation:
 * 1. Generate CSRF token and secret
 * 2. Store secret in session
 * 3. Send token to client
 * 4. Verify token on state-changing requests (POST, PUT, DELETE)
 */

interface CSRFSession {
  csrfSecret?: string
  csrfTokens?: Set<string>
}

/**
 * Generate CSRF Token
 * GET /api/csrf-token
 */
export const generateCsrfToken: PayloadHandler = async (req, res) => {
  try {
    // Generate secret and token
    const secret = randomBytes(32).toString('hex')
    const token = createHash('sha256')
      .update(secret + req.user?.id || req.ip)
      .digest('hex')

    // Store secret in session
    // @ts-ignore - Extend session type
    if (!req.session) {
      req.session = {}
    }

    const session = req.session as CSRFSession
    session.csrfSecret = secret

    // Initialize token set
    if (!session.csrfTokens) {
      session.csrfTokens = new Set()
    }
    session.csrfTokens.add(token)

    res.json({
      csrfToken: token,
      expiresIn: 3600 // 1 hour
    })
  } catch (error) {
    req.payload.logger.error(`CSRF token generation error: ${error}`)
    res.status(500).json({ error: 'Failed to generate CSRF token' })
  }
}

/**
 * Verify CSRF Token Middleware
 * Apply to all state-changing operations (POST, PUT, DELETE, PATCH)
 */
export const verifyCsrfToken: PayloadHandler = (req, res, next) => {
  // Skip CSRF check for GET and HEAD requests
  if (req.method === 'GET' || req.method === 'HEAD') {
    return next()
  }

  try {
    // Get token from header
    const token =
      req.headers['x-csrf-token'] ||
      req.headers['csrf-token'] ||
      req.body?._csrf

    if (!token || typeof token !== 'string') {
      return res.status(403).json({
        error: 'CSRF token required',
        message:
          'Please include X-CSRF-Token header or _csrf field in request'
      })
    }

    // Get session
    const session = req.session as CSRFSession

    if (!session?.csrfSecret || !session?.csrfTokens) {
      return res.status(403).json({
        error: 'Invalid session',
        message: 'Please refresh the page and try again'
      })
    }

    // Verify token
    const expectedToken = createHash('sha256')
      .update(session.csrfSecret + (req.user?.id || req.ip))
      .digest('hex')

    if (token !== expectedToken || !session.csrfTokens.has(token)) {
      return res.status(403).json({
        error: 'Invalid CSRF token',
        message: 'Security check failed. Please refresh the page and try again.'
      })
    }

    // Token is valid - remove it (one-time use)
    session.csrfTokens.delete(token)

    next()
  } catch (error) {
    req.payload.logger.error(`CSRF verification error: ${error}`)
    return res.status(500).json({
      error: 'CSRF verification failed'
    })
  }
}

/**
 * Optional CSRF Protection
 * Verifies token if present but doesn't require it
 * Useful for endpoints that support both web and API access
 */
export const optionalCsrfProtection: PayloadHandler = (req, res, next) => {
  // Skip for GET/HEAD
  if (req.method === 'GET' || req.method === 'HEAD') {
    return next()
  }

  const token =
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    req.body?._csrf

  // If no token provided, skip verification
  if (!token) {
    return next()
  }

  // If token provided, verify it
  verifyCsrfToken(req, res, next)
}

/**
 * CSRF Configuration for Payload
 * Add to payload.config.ts endpoints
 */
export const csrfEndpoints = [
  {
    path: '/csrf-token',
    method: 'get' as const,
    handler: generateCsrfToken
  }
]

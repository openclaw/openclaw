/**
 * CSRF (Cross-Site Request Forgery) Protection Utilities
 * Implements double-submit cookie pattern for stateless CSRF protection
 */

import { randomBytes, createHmac } from 'crypto'

const CSRF_SECRET = process.env.CSRF_SECRET || process.env.PAYLOAD_SECRET || 'default-csrf-secret'
const TOKEN_LENGTH = 32

/**
 * Generates a CSRF token
 * Uses HMAC to create a signed token that can be verified without server-side storage
 */
export function generateCsrfToken(): string {
  const timestamp = Date.now().toString()
  const random = randomBytes(TOKEN_LENGTH).toString('hex')
  const data = `${timestamp}:${random}`

  // Create HMAC signature
  const signature = createHmac('sha256', CSRF_SECRET).update(data).digest('hex')

  // Combine data and signature
  const token = `${data}:${signature}`

  return Buffer.from(token).toString('base64url')
}

/**
 * Verifies a CSRF token
 * @param token - The token to verify
 * @param maxAge - Maximum age of token in milliseconds (default: 1 hour)
 * @returns true if valid, false otherwise
 */
export function verifyCsrfToken(token: string, maxAge: number = 3600000): boolean {
  try {
    // Decode token
    const decoded = Buffer.from(token, 'base64url').toString('utf-8')
    const parts = decoded.split(':')

    if (parts.length !== 3) {
      return false
    }

    const [timestamp, random, signature] = parts

    // Verify signature
    const data = `${timestamp}:${random}`
    const expectedSignature = createHmac('sha256', CSRF_SECRET).update(data).digest('hex')

    if (signature !== expectedSignature) {
      return false
    }

    // Check token age
    const tokenTime = parseInt(timestamp, 10)
    const now = Date.now()

    if (now - tokenTime > maxAge) {
      return false
    }

    return true
  } catch (error) {
    return false
  }
}

/**
 * Express/Payload middleware to verify CSRF tokens
 */
export function csrfMiddleware(req: any, res: any, next: any): void {
  // Skip verification for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next()
  }

  // Get token from header or body
  const token =
    req.headers['x-csrf-token'] ||
    req.headers['csrf-token'] ||
    req.body?.csrfToken ||
    req.query?.csrfToken

  if (!token) {
    return res.status(403).json({
      error: 'CSRF token missing',
      message: 'CSRF protection requires a valid token for state-changing operations'
    })
  }

  if (!verifyCsrfToken(token)) {
    return res.status(403).json({
      error: 'CSRF token invalid',
      message: 'The CSRF token is invalid or expired'
    })
  }

  next()
}

/**
 * Client-side helper to get CSRF token
 * Usage: const token = await getCsrfToken()
 */
export async function getCsrfTokenClient(): Promise<string> {
  const response = await fetch('/api/csrf-token')
  const data = await response.json()
  return data.csrfToken
}

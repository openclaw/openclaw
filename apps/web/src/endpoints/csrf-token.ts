/**
 * CSRF Token Endpoint
 * Provides fresh CSRF tokens to authenticated clients
 */

import type { PayloadHandler } from 'payload'
import { generateCsrfToken } from '../lib/utils/csrf'

/**
 * GET /api/csrf-token
 * Returns a fresh CSRF token for the client
 */
export const getCsrfToken: PayloadHandler = async (req, res) => {
  try {
    const token = generateCsrfToken()

    res.status(200).json({
      csrfToken: token,
      expiresIn: 3600000 // 1 hour in milliseconds
    })
  } catch (error) {
    req.payload.logger.error(`CSRF token generation error: ${error}`)
    res.status(500).json({
      error: 'Internal server error'
    })
  }
}

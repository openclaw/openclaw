import type { PayloadHandler } from 'payload'
import { isAddress } from 'ethers'
import DOMPurify from 'isomorphic-dompurify'

/**
 * Input Validation Utilities
 * Prevents injection attacks and ensures data integrity
 */

/**
 * Ethereum Address Validation
 */
export function validateEthereumAddress(address: string): boolean {
  return isAddress(address)
}

/**
 * Token ID Validation
 */
export function validateTokenId(tokenId: string | number): boolean {
  const id = typeof tokenId === 'string' ? parseInt(tokenId, 10) : tokenId
  return !isNaN(id) && id >= 0 && id < Number.MAX_SAFE_INTEGER
}

/**
 * Price Validation (in CLAW tokens)
 */
export function validatePrice(price: number): {
  valid: boolean
  error?: string
} {
  if (typeof price !== 'number' || isNaN(price)) {
    return { valid: false, error: 'Price must be a number' }
  }

  if (price <= 0) {
    return { valid: false, error: 'Price must be greater than 0' }
  }

  if (price > 1000000000) {
    // 1 billion CLAW max
    return { valid: false, error: 'Price exceeds maximum allowed value' }
  }

  if (!Number.isFinite(price)) {
    return { valid: false, error: 'Price must be finite' }
  }

  return { valid: true }
}

/**
 * Days Validation (for rental periods)
 */
export function validateDays(days: number): {
  valid: boolean
  error?: string
} {
  if (typeof days !== 'number' || isNaN(days)) {
    return { valid: false, error: 'Days must be a number' }
  }

  if (!Number.isInteger(days)) {
    return { valid: false, error: 'Days must be an integer' }
  }

  if (days < 1) {
    return { valid: false, error: 'Rental period must be at least 1 day' }
  }

  if (days > 365) {
    return { valid: false, error: 'Rental period cannot exceed 365 days' }
  }

  return { valid: true }
}

/**
 * Rating Validation (1-5 stars)
 */
export function validateRating(rating: number): {
  valid: boolean
  error?: string
} {
  if (typeof rating !== 'number' || isNaN(rating)) {
    return { valid: false, error: 'Rating must be a number' }
  }

  if (!Number.isInteger(rating)) {
    return { valid: false, error: 'Rating must be an integer' }
  }

  if (rating < 1 || rating > 5) {
    return { valid: false, error: 'Rating must be between 1 and 5' }
  }

  return { valid: true }
}

/**
 * Sanitize HTML Content
 * Prevents XSS attacks
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      'a',
      'ul',
      'ol',
      'li',
      'blockquote',
      'code',
      'pre'
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel'],
    ALLOW_DATA_ATTR: false
  })
}

/**
 * Validate Bot ID Format
 */
export function validateBotId(botId: string): {
  valid: boolean
  error?: string
} {
  if (!botId || typeof botId !== 'string') {
    return { valid: false, error: 'Bot ID is required' }
  }

  // Payload CMS IDs are typically MongoDB ObjectIDs (24 hex characters)
  // or UUIDs
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(botId)
  const isUUID =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      botId
    )

  if (!isObjectId && !isUUID) {
    return { valid: false, error: 'Invalid Bot ID format' }
  }

  return { valid: true }
}

/**
 * Validate Post Content
 */
export function validatePostContent(content: string): {
  valid: boolean
  error?: string
  sanitized?: string
} {
  if (!content || typeof content !== 'string') {
    return { valid: false, error: 'Content is required' }
  }

  if (content.length > 5000) {
    return { valid: false, error: 'Content exceeds maximum length (5000 characters)' }
  }

  // Sanitize content
  const sanitized = sanitizeHtml(content)

  return { valid: true, sanitized }
}

/**
 * Middleware: Validate Blockchain Request
 */
export const validateBlockchainRequest: PayloadHandler = (req, res, next) => {
  try {
    const { botId, ownerAddress, price, pricePerDay, days, tokenId, rating } =
      req.body

    // Validate Bot ID if present
    if (botId) {
      const botIdValidation = validateBotId(botId)
      if (!botIdValidation.valid) {
        return res.status(400).json({ error: botIdValidation.error })
      }
    }

    // Validate Ethereum Address if present
    if (ownerAddress && !validateEthereumAddress(ownerAddress)) {
      return res.status(400).json({ error: 'Invalid Ethereum address' })
    }

    // Validate Price if present
    if (price !== undefined) {
      const priceValidation = validatePrice(price)
      if (!priceValidation.valid) {
        return res.status(400).json({ error: priceValidation.error })
      }
    }

    // Validate Price Per Day if present
    if (pricePerDay !== undefined) {
      const priceValidation = validatePrice(pricePerDay)
      if (!priceValidation.valid) {
        return res.status(400).json({ error: priceValidation.error })
      }
    }

    // Validate Days if present
    if (days !== undefined) {
      const daysValidation = validateDays(days)
      if (!daysValidation.valid) {
        return res.status(400).json({ error: daysValidation.error })
      }
    }

    // Validate Token ID if present
    if (tokenId !== undefined && !validateTokenId(tokenId)) {
      return res.status(400).json({ error: 'Invalid token ID' })
    }

    // Validate Rating if present
    if (rating !== undefined) {
      const ratingValidation = validateRating(rating)
      if (!ratingValidation.valid) {
        return res.status(400).json({ error: ratingValidation.error })
      }
    }

    next()
  } catch (error) {
    req.payload.logger.error(`Validation error: ${error}`)
    return res.status(500).json({ error: 'Validation failed' })
  }
}

/**
 * Middleware: Validate Social Post
 */
export const validateSocialPost: PayloadHandler = (req, res, next) => {
  try {
    const { content, contentText } = req.body

    const textToValidate = contentText || content

    if (!textToValidate) {
      return res.status(400).json({
        error: 'Post content is required'
      })
    }

    const validation = validatePostContent(textToValidate)

    if (!validation.valid) {
      return res.status(400).json({ error: validation.error })
    }

    // Replace content with sanitized version
    if (validation.sanitized) {
      req.body.contentText = validation.sanitized
    }

    next()
  } catch (error) {
    req.payload.logger.error(`Post validation error: ${error}`)
    return res.status(500).json({ error: 'Validation failed' })
  }
}

/**
 * Middleware: Sanitize Query Parameters
 * Prevents injection via query strings
 */
export const sanitizeQueryParams: PayloadHandler = (req, res, next) => {
  try {
    if (req.query) {
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          // Remove potentially dangerous characters
          req.query[key] = value.replace(/[<>'"]/g, '')

          // Limit length
          if (req.query[key].length > 1000) {
            req.query[key] = req.query[key].substring(0, 1000)
          }
        }
      }
    }

    next()
  } catch (error) {
    req.payload.logger.error(`Query sanitization error: ${error}`)
    return res.status(500).json({ error: 'Request processing failed' })
  }
}

/**
 * Middleware: Validate Pagination Parameters
 */
export const validatePagination: PayloadHandler = (req, res, next) => {
  try {
    let { limit, offset, page } = req.query

    // Parse and validate limit
    if (limit) {
      const parsedLimit = parseInt(limit as string, 10)

      if (isNaN(parsedLimit) || parsedLimit < 1) {
        return res.status(400).json({
          error: 'Invalid limit parameter'
        })
      }

      if (parsedLimit > 100) {
        // Max 100 items per page
        req.query.limit = '100'
      }
    }

    // Parse and validate offset
    if (offset) {
      const parsedOffset = parseInt(offset as string, 10)

      if (isNaN(parsedOffset) || parsedOffset < 0) {
        return res.status(400).json({
          error: 'Invalid offset parameter'
        })
      }
    }

    // Parse and validate page
    if (page) {
      const parsedPage = parseInt(page as string, 10)

      if (isNaN(parsedPage) || parsedPage < 1) {
        return res.status(400).json({
          error: 'Invalid page parameter'
        })
      }
    }

    next()
  } catch (error) {
    req.payload.logger.error(`Pagination validation error: ${error}`)
    return res.status(500).json({ error: 'Validation failed' })
  }
}

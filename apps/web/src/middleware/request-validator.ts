import type { PayloadHandler } from 'payload'
import {
  validatePostData,
  validateCommentData,
  validateProfileData,
  validateBotData,
  validateBlockchainData,
  createValidator
} from '../lib/validation/validator'
import { getErrorLogger } from '../lib/errors/error-handler'

/**
 * Request Validation Middleware
 * Validates incoming request data before processing
 */

/**
 * Validate post creation/update
 */
export const validatePost: PayloadHandler = (req, res, next) => {
  const result = validatePostData(req.body)

  if (!result.valid) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logValidation(result.errors, {
      path: req.path,
      method: req.method
    })

    return res.status(400).json({
      error: 'Validation failed',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  next()
}

/**
 * Validate comment creation
 */
export const validateComment: PayloadHandler = (req, res, next) => {
  const result = validateCommentData(req.body)

  if (!result.valid) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logValidation(result.errors, {
      path: req.path,
      method: req.method
    })

    return res.status(400).json({
      error: 'Validation failed',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  next()
}

/**
 * Validate profile update
 */
export const validateProfile: PayloadHandler = (req, res, next) => {
  const result = validateProfileData(req.body)

  if (!result.valid) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logValidation(result.errors)

    return res.status(400).json({
      error: 'Validation failed',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  next()
}

/**
 * Validate bot creation/update
 */
export const validateBot: PayloadHandler = (req, res, next) => {
  const result = validateBotData(req.body)

  if (!result.valid) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logValidation(result.errors)

    return res.status(400).json({
      error: 'Validation failed',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  next()
}

/**
 * Validate blockchain request
 */
export const validateBlockchain: PayloadHandler = (req, res, next) => {
  const result = validateBlockchainData(req.body)

  if (!result.valid) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logValidation(result.errors)

    return res.status(400).json({
      error: 'Validation failed',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  next()
}

/**
 * Validate pagination parameters
 */
export const validatePaginationParams: PayloadHandler = (req, res, next) => {
  const validator = createValidator()

  const page = req.query.page ? parseInt(req.query.page as string, 10) : 1
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20

  validator
    .numberRange(page, 'Page', { min: 1, max: 1000 })
    .numberRange(limit, 'Limit', { min: 1, max: 100 })

  const result = validator.getResult()

  if (!result.valid) {
    return res.status(400).json({
      error: 'Invalid pagination parameters',
      details: result.errors.map((e) => ({
        field: e.context?.field,
        message: e.message
      }))
    })
  }

  // Attach validated params to request
  req.paginationParams = { page, limit, offset: (page - 1) * limit }

  next()
}

/**
 * Validate ID parameter
 */
export function validateIdParam(paramName: string = 'id'): PayloadHandler {
  return (req, res, next) => {
    const id = req.params[paramName]

    if (!id) {
      return res.status(400).json({
        error: `Missing ${paramName} parameter`
      })
    }

    // Validate ID format (assuming MongoDB ObjectId or similar)
    if (typeof id !== 'string' || id.length === 0) {
      return res.status(400).json({
        error: `Invalid ${paramName} format`
      })
    }

    next()
  }
}

/**
 * Validate query string parameters
 */
export function validateQueryParams(
  schema: Record<string, { type: 'string' | 'number' | 'boolean'; required?: boolean }>
): PayloadHandler {
  return (req, res, next) => {
    const validator = createValidator()
    const errors: string[] = []

    for (const [param, config] of Object.entries(schema)) {
      const value = req.query[param]

      if (config.required && !value) {
        errors.push(`${param} is required`)
        continue
      }

      if (value !== undefined) {
        switch (config.type) {
          case 'number':
            const num = parseFloat(value as string)
            if (isNaN(num)) {
              errors.push(`${param} must be a number`)
            }
            break

          case 'boolean':
            if (value !== 'true' && value !== 'false') {
              errors.push(`${param} must be true or false`)
            }
            break

          case 'string':
            if (typeof value !== 'string') {
              errors.push(`${param} must be a string`)
            }
            break
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Invalid query parameters',
        details: errors
      })
    }

    next()
  }
}

/**
 * Validate file upload
 */
export function validateFileUpload(options: {
  maxSize?: number // bytes
  allowedTypes?: string[] // MIME types
  required?: boolean
}): PayloadHandler {
  return (req, res, next) => {
    const files = req.files

    if (options.required && (!files || Object.keys(files).length === 0)) {
      return res.status(400).json({
        error: 'File upload required'
      })
    }

    if (files && Object.keys(files).length > 0) {
      for (const [fieldName, fileArray] of Object.entries(files)) {
        const file = Array.isArray(fileArray) ? fileArray[0] : fileArray

        // Check file size
        if (options.maxSize && file.size > options.maxSize) {
          return res.status(400).json({
            error: `File ${fieldName} exceeds maximum size of ${options.maxSize} bytes`
          })
        }

        // Check MIME type
        if (options.allowedTypes && !options.allowedTypes.includes(file.mimetype)) {
          return res.status(400).json({
            error: `File ${fieldName} has invalid type. Allowed: ${options.allowedTypes.join(', ')}`
          })
        }
      }
    }

    next()
  }
}

/**
 * Sanitize request body
 */
export const sanitizeRequestBody: PayloadHandler = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeObject(req.body)
  }

  next()
}

/**
 * Recursively sanitize object
 */
function sanitizeObject(obj: any): any {
  if (typeof obj === 'string') {
    // Trim whitespace
    return obj.trim()
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject)
  }

  if (obj && typeof obj === 'object') {
    const sanitized: any = {}
    for (const [key, value] of Object.entries(obj)) {
      sanitized[key] = sanitizeObject(value)
    }
    return sanitized
  }

  return obj
}

/**
 * Rate limit validation
 */
export const validateRateLimit: PayloadHandler = (req, res, next) => {
  // Check if rate limit headers exist
  const remaining = res.getHeader('X-RateLimit-Remaining')

  if (remaining !== undefined && parseInt(remaining as string, 10) <= 0) {
    const errorLogger = getErrorLogger(req.payload)
    errorLogger.logSecurity('Rate limit exceeded', {
      userId: req.user?.id,
      ip: req.ip,
      path: req.path
    })

    return res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.'
    })
  }

  next()
}

declare global {
  namespace Express {
    interface Request {
      paginationParams?: {
        page: number
        limit: number
        offset: number
      }
    }
  }
}

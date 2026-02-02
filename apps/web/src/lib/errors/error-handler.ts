import type { Payload } from 'payload'

/**
 * Custom Error Classes for ClawNet
 */

export class AppError extends Error {
  public readonly statusCode: number
  public readonly isOperational: boolean
  public readonly context?: Record<string, any>

  constructor(
    message: string,
    statusCode: number = 500,
    isOperational: boolean = true,
    context?: Record<string, any>
  ) {
    super(message)
    this.name = this.constructor.name
    this.statusCode = statusCode
    this.isOperational = isOperational
    this.context = context

    Error.captureStackTrace(this, this.constructor)
  }
}

export class ValidationError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 400, true, context)
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required', context?: Record<string, any>) {
    super(message, 401, true, context)
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions', context?: Record<string, any>) {
    super(message, 403, true, context)
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = id ? `${resource} with id ${id} not found` : `${resource} not found`
    super(message, 404, true, { resource, id })
  }
}

export class ConflictError extends AppError {
  constructor(message: string, context?: Record<string, any>) {
    super(message, 409, true, context)
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfter: number, context?: Record<string, any>) {
    super('Too many requests. Please try again later.', 429, true, {
      ...context,
      retryAfter
    })
  }
}

export class ExternalServiceError extends AppError {
  constructor(service: string, originalError: Error, context?: Record<string, any>) {
    super(`External service error: ${service}`, 502, true, {
      ...context,
      service,
      originalError: originalError.message
    })
  }
}

export class DatabaseError extends AppError {
  constructor(operation: string, originalError: Error, context?: Record<string, any>) {
    super(`Database error during ${operation}`, 500, false, {
      ...context,
      operation,
      originalError: originalError.message
    })
  }
}

/**
 * Error Logging Service
 */
export class ErrorLogger {
  constructor(private payload: Payload) {}

  /**
   * Log error with context
   */
  log(error: Error, context?: Record<string, any>): void {
    const isAppError = error instanceof AppError
    const errorData = {
      name: error.name,
      message: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
      ...(isAppError && {
        statusCode: error.statusCode,
        isOperational: error.isOperational,
        errorContext: error.context
      }),
      ...context
    }

    if (isAppError && error.isOperational) {
      // Operational errors (expected errors)
      this.payload.logger.warn(`[Operational Error] ${error.message}`, errorData)
    } else {
      // Programming errors or unexpected errors
      this.payload.logger.error(`[Critical Error] ${error.message}`, errorData)
    }

    // In production, send to error monitoring service (Sentry, Datadog, etc.)
    if (process.env.NODE_ENV === 'production') {
      this.sendToMonitoring(errorData)
    }
  }

  /**
   * Send error to monitoring service
   */
  private sendToMonitoring(errorData: Record<string, any>): void {
    // TODO: Integrate with Sentry, Datadog, or similar
    // Example:
    // Sentry.captureException(errorData)
  }

  /**
   * Log validation errors
   */
  logValidation(errors: ValidationError[], context?: Record<string, any>): void {
    this.payload.logger.warn('[Validation Errors]', {
      count: errors.length,
      errors: errors.map((e) => ({
        message: e.message,
        context: e.context
      })),
      ...context
    })
  }

  /**
   * Log security events
   */
  logSecurity(event: string, details: Record<string, any>): void {
    this.payload.logger.warn(`[Security Event] ${event}`, {
      timestamp: new Date().toISOString(),
      ...details
    })
  }
}

/**
 * Get ErrorLogger instance
 */
export function getErrorLogger(payload: Payload): ErrorLogger {
  return new ErrorLogger(payload)
}

/**
 * Error Response Formatter
 */
export function formatErrorResponse(error: Error, includeStack: boolean = false) {
  if (error instanceof AppError) {
    const response: any = {
      error: error.message,
      statusCode: error.statusCode
    }

    if (error.context) {
      response.details = error.context
    }

    if (includeStack && error.stack) {
      response.stack = error.stack
    }

    return response
  }

  // Generic error
  return {
    error: process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : error.message,
    statusCode: 500,
    ...(includeStack && { stack: error.stack })
  }
}

/**
 * Global Error Handler Middleware
 */
export function globalErrorHandler(payload: Payload) {
  const errorLogger = getErrorLogger(payload)

  return (error: Error, req: any, res: any, next: any) => {
    // Log the error
    errorLogger.log(error, {
      method: req.method,
      path: req.path,
      userId: req.user?.id,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    })

    // Determine status code
    const statusCode = error instanceof AppError ? error.statusCode : 500

    // Format response
    const includeStack = process.env.NODE_ENV === 'development'
    const response = formatErrorResponse(error, includeStack)

    // Send response
    res.status(statusCode).json(response)
  }
}

/**
 * Async handler wrapper to catch errors in async route handlers
 */
export function asyncHandler(fn: Function) {
  return (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

/**
 * Safe JSON parse with error handling
 */
export function safeJsonParse<T = any>(
  json: string,
  defaultValue: T
): T {
  try {
    return JSON.parse(json)
  } catch (error) {
    return defaultValue
  }
}

/**
 * Assert condition with custom error
 */
export function assert(
  condition: boolean,
  errorClass: typeof AppError,
  message: string,
  context?: Record<string, any>
): asserts condition {
  if (!condition) {
    throw new errorClass(message, context)
  }
}

/**
 * Retry function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number
    delayMs?: number
    backoffMultiplier?: number
    onRetry?: (attempt: number, error: Error) => void
  } = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delayMs = 1000,
    backoffMultiplier = 2,
    onRetry
  } = options

  let lastError: Error

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error: any) {
      lastError = error

      if (attempt === maxAttempts) {
        break
      }

      if (onRetry) {
        onRetry(attempt, error)
      }

      // Wait before retrying
      const delay = delayMs * Math.pow(backoffMultiplier, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw new AppError(
    `Operation failed after ${maxAttempts} attempts`,
    500,
    false,
    { lastError: lastError!.message }
  )
}

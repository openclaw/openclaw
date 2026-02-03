import { ValidationError } from '../errors/error-handler'
import { isAddress } from 'ethers'
import DOMPurify from 'isomorphic-dompurify'

/**
 * Validation Result
 */
export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

/**
 * Field Validator
 */
export class Validator {
  private errors: ValidationError[] = []

  /**
   * Validate required field
   */
  required(value: any, fieldName: string): this {
    if (value === null || value === undefined || value === '') {
      this.errors.push(
        new ValidationError(`${fieldName} is required`, { field: fieldName })
      )
    }
    return this
  }

  /**
   * Validate string length
   */
  stringLength(
    value: string,
    fieldName: string,
    options: { min?: number; max?: number }
  ): this {
    if (typeof value !== 'string') {
      this.errors.push(
        new ValidationError(`${fieldName} must be a string`, { field: fieldName })
      )
      return this
    }

    if (options.min !== undefined && value.length < options.min) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must be at least ${options.min} characters`,
          { field: fieldName, minLength: options.min, actualLength: value.length }
        )
      )
    }

    if (options.max !== undefined && value.length > options.max) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must be at most ${options.max} characters`,
          { field: fieldName, maxLength: options.max, actualLength: value.length }
        )
      )
    }

    return this
  }

  /**
   * Validate email format
   */
  email(value: string, fieldName: string = 'Email'): this {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(value)) {
      this.errors.push(
        new ValidationError(`${fieldName} must be a valid email address`, {
          field: fieldName,
          value
        })
      )
    }
    return this
  }

  /**
   * Validate username format
   */
  username(value: string, fieldName: string = 'Username'): this {
    const usernameRegex = /^[a-z0-9_-]+$/
    if (!usernameRegex.test(value)) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must contain only lowercase letters, numbers, underscores, and hyphens`,
          { field: fieldName, value }
        )
      )
    }

    if (value.length < 3 || value.length > 30) {
      this.errors.push(
        new ValidationError(`${fieldName} must be between 3 and 30 characters`, {
          field: fieldName,
          length: value.length
        })
      )
    }

    return this
  }

  /**
   * Validate Ethereum address
   */
  ethereumAddress(value: string, fieldName: string = 'Address'): this {
    if (!isAddress(value)) {
      this.errors.push(
        new ValidationError(`${fieldName} must be a valid Ethereum address`, {
          field: fieldName,
          value
        })
      )
    }
    return this
  }

  /**
   * Validate number range
   */
  numberRange(
    value: number,
    fieldName: string,
    options: { min?: number; max?: number }
  ): this {
    if (typeof value !== 'number' || isNaN(value)) {
      this.errors.push(
        new ValidationError(`${fieldName} must be a number`, { field: fieldName })
      )
      return this
    }

    if (options.min !== undefined && value < options.min) {
      this.errors.push(
        new ValidationError(`${fieldName} must be at least ${options.min}`, {
          field: fieldName,
          min: options.min,
          actual: value
        })
      )
    }

    if (options.max !== undefined && value > options.max) {
      this.errors.push(
        new ValidationError(`${fieldName} must be at most ${options.max}`, {
          field: fieldName,
          max: options.max,
          actual: value
        })
      )
    }

    return this
  }

  /**
   * Validate URL format
   */
  url(value: string, fieldName: string = 'URL'): this {
    try {
      new URL(value)
    } catch {
      this.errors.push(
        new ValidationError(`${fieldName} must be a valid URL`, {
          field: fieldName,
          value
        })
      )
    }
    return this
  }

  /**
   * Validate date
   */
  date(value: any, fieldName: string = 'Date'): this {
    const date = new Date(value)
    if (isNaN(date.getTime())) {
      this.errors.push(
        new ValidationError(`${fieldName} must be a valid date`, {
          field: fieldName,
          value
        })
      )
    }
    return this
  }

  /**
   * Validate date range
   */
  dateRange(
    value: any,
    fieldName: string,
    options: { after?: Date; before?: Date }
  ): this {
    const date = new Date(value)
    if (isNaN(date.getTime())) {
      this.errors.push(
        new ValidationError(`${fieldName} must be a valid date`, { field: fieldName })
      )
      return this
    }

    if (options.after && date <= options.after) {
      this.errors.push(
        new ValidationError(`${fieldName} must be after ${options.after.toISOString()}`, {
          field: fieldName,
          after: options.after.toISOString(),
          actual: date.toISOString()
        })
      )
    }

    if (options.before && date >= options.before) {
      this.errors.push(
        new ValidationError(`${fieldName} must be before ${options.before.toISOString()}`, {
          field: fieldName,
          before: options.before.toISOString(),
          actual: date.toISOString()
        })
      )
    }

    return this
  }

  /**
   * Validate enum value
   */
  enum(value: any, fieldName: string, allowedValues: any[]): this {
    if (!allowedValues.includes(value)) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must be one of: ${allowedValues.join(', ')}`,
          { field: fieldName, value, allowedValues }
        )
      )
    }
    return this
  }

  /**
   * Validate array
   */
  array(
    value: any,
    fieldName: string,
    options?: { minLength?: number; maxLength?: number }
  ): this {
    if (!Array.isArray(value)) {
      this.errors.push(
        new ValidationError(`${fieldName} must be an array`, { field: fieldName })
      )
      return this
    }

    if (options?.minLength !== undefined && value.length < options.minLength) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must contain at least ${options.minLength} items`,
          { field: fieldName, minLength: options.minLength, actualLength: value.length }
        )
      )
    }

    if (options?.maxLength !== undefined && value.length > options.maxLength) {
      this.errors.push(
        new ValidationError(
          `${fieldName} must contain at most ${options.maxLength} items`,
          { field: fieldName, maxLength: options.maxLength, actualLength: value.length }
        )
      )
    }

    return this
  }

  /**
   * Custom validation
   */
  custom(
    condition: boolean,
    fieldName: string,
    message: string,
    context?: Record<string, any>
  ): this {
    if (!condition) {
      this.errors.push(new ValidationError(message, { field: fieldName, ...context }))
    }
    return this
  }

  /**
   * Sanitize HTML content
   */
  sanitizeHtml(value: string): string {
    return DOMPurify.sanitize(value, {
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
        'pre',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6'
      ],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
      ALLOW_DATA_ATTR: false
    })
  }

  /**
   * Get validation result
   */
  getResult(): ValidationResult {
    return {
      valid: this.errors.length === 0,
      errors: this.errors
    }
  }

  /**
   * Throw if validation failed
   */
  throwIfInvalid(): void {
    if (this.errors.length > 0) {
      throw this.errors[0] // Throw first error
    }
  }

  /**
   * Get all errors
   */
  getErrors(): ValidationError[] {
    return this.errors
  }
}

/**
 * Create new validator
 */
export function createValidator(): Validator {
  return new Validator()
}

/**
 * Validate post creation data
 */
export function validatePostData(data: any): ValidationResult {
  const validator = createValidator()

  validator
    .required(data.contentText, 'Content')
    .stringLength(data.contentText, 'Content', { min: 1, max: 5000 })

  if (data.author) {
    validator.required(data.author, 'Author')
  }

  if (data.visibility) {
    validator.enum(data.visibility, 'Visibility', ['public', 'followers', 'private'])
  }

  if (data.mentions && Array.isArray(data.mentions)) {
    validator.array(data.mentions, 'Mentions', { maxLength: 10 })
  }

  return validator.getResult()
}

/**
 * Validate comment creation data
 */
export function validateCommentData(data: any): ValidationResult {
  const validator = createValidator()

  validator
    .required(data.content, 'Content')
    .required(data.post, 'Post')
    .required(data.author, 'Author')

  return validator.getResult()
}

/**
 * Validate profile update data
 */
export function validateProfileData(data: any): ValidationResult {
  const validator = createValidator()

  if (data.username) {
    validator.username(data.username)
  }

  if (data.displayName) {
    validator.stringLength(data.displayName, 'Display Name', { min: 1, max: 50 })
  }

  if (data.bio) {
    validator.stringLength(data.bio, 'Bio', { max: 500 })
  }

  if (data.website) {
    validator.url(data.website, 'Website')
  }

  return validator.getResult()
}

/**
 * Validate bot creation data
 */
export function validateBotData(data: any): ValidationResult {
  const validator = createValidator()

  validator
    .required(data.name, 'Name')
    .stringLength(data.name, 'Name', { min: 3, max: 50 })
    .required(data.model, 'Model')
    .enum(data.model, 'Model', [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4',
      'claude-3-5-sonnet-20241022'
    ])

  if (data.systemPrompt) {
    validator.stringLength(data.systemPrompt, 'System Prompt', { max: 10000 })
  }

  return validator.getResult()
}

/**
 * Validate blockchain transaction data
 */
export function validateBlockchainData(data: any): ValidationResult {
  const validator = createValidator()

  if (data.ownerAddress) {
    validator.ethereumAddress(data.ownerAddress, 'Owner Address')
  }

  if (data.buyerAddress) {
    validator.ethereumAddress(data.buyerAddress, 'Buyer Address')
  }

  if (data.price !== undefined) {
    validator.numberRange(data.price, 'Price', { min: 0, max: 1000000000 })
  }

  if (data.tokenId !== undefined) {
    validator.numberRange(data.tokenId, 'Token ID', { min: 0 })
  }

  return validator.getResult()
}

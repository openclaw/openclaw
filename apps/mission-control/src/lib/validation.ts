/**
 * Input validation utilities for API endpoints.
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate string input with length limits.
 */
export function validateString(
  value: unknown,
  fieldName: string,
  options: {
    required?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    patternMessage?: string;
  } = {}
): ValidationResult {
  const {
    required = true,
    minLength = 1,
    maxLength = 10000,
    pattern,
    patternMessage,
  } = options;

  if (value === undefined || value === null || value === "") {
    if (required) {
      return { valid: false, error: `${fieldName} is required` };
    }
    return { valid: true };
  }

  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (value.length < minLength) {
    return {
      valid: false,
      error: `${fieldName} must be at least ${minLength} characters`,
    };
  }

  if (value.length > maxLength) {
    return {
      valid: false,
      error: `${fieldName} must be at most ${maxLength} characters`,
    };
  }

  if (pattern && !pattern.test(value)) {
    return {
      valid: false,
      error: patternMessage || `${fieldName} has invalid format`,
    };
  }

  return { valid: true };
}

/**
 * Validate UUID format.
 */
export function validateUuid(value: unknown, fieldName: string): ValidationResult {
  return validateString(value, fieldName, {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    patternMessage: `${fieldName} must be a valid UUID`,
  });
}

/**
 * Validate enum value.
 */
export function validateEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
  options: { required?: boolean } = {}
): ValidationResult {
  const { required = true } = options;

  if (value === undefined || value === null) {
    if (required) {
      return { valid: false, error: `${fieldName} is required` };
    }
    return { valid: true };
  }

  if (typeof value !== "string") {
    return { valid: false, error: `${fieldName} must be a string` };
  }

  if (!allowedValues.includes(value as T)) {
    return {
      valid: false,
      error: `${fieldName} must be one of: ${allowedValues.join(", ")}`,
    };
  }

  return { valid: true };
}

/**
 * Common field length limits.
 */
export const FieldLimits = {
  title: { minLength: 1, maxLength: 500 },
  description: { minLength: 0, maxLength: 50000 },
  comment: { minLength: 1, maxLength: 100000 },
  message: { minLength: 1, maxLength: 500000 },
  name: { minLength: 1, maxLength: 200 },
  id: { minLength: 1, maxLength: 100 },
};

/**
 * Sanitize string input (trim, normalize whitespace).
 */
export function sanitizeInput(value: string): string {
  return value
    .trim()
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

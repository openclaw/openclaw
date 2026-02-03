/**
 * HTML Sanitization Utilities
 * Prevents XSS attacks by escaping or sanitizing user-generated content
 */

/**
 * Escapes HTML entities in a string to prevent XSS
 * Use this for plain text that should not contain any HTML
 */
export function escapeHtml(text: string): string {
  const htmlEntities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
    '/': '&#x2F;'
  }

  return text.replace(/[&<>"'/]/g, (char) => htmlEntities[char] || char)
}

/**
 * Sanitizes text for safe rendering in React
 * Preserves newlines and basic formatting while preventing XSS
 */
export function sanitizeText(text: string): string {
  if (!text) return ''

  // Escape all HTML entities
  return escapeHtml(text)
}

/**
 * Sanitizes URLs to prevent javascript: and data: URIs
 */
export function sanitizeUrl(url: string): string {
  if (!url) return ''

  const trimmed = url.trim().toLowerCase()

  // Block dangerous protocols
  if (
    trimmed.startsWith('javascript:') ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('vbscript:') ||
    trimmed.startsWith('file:')
  ) {
    return ''
  }

  return url
}

/**
 * Extracts and sanitizes URLs from text for link preview
 */
export function extractUrls(text: string): string[] {
  const urlRegex = /(https?:\/\/[^\s]+)/g
  const urls = text.match(urlRegex) || []
  return urls.map(sanitizeUrl).filter(Boolean)
}

/**
 * Sanitizes username to prevent XSS in @mentions
 */
export function sanitizeUsername(username: string): string {
  if (!username) return ''

  // Only allow alphanumeric, underscore, and hyphen
  return username.replace(/[^a-zA-Z0-9_-]/g, '')
}

/**
 * Detects potentially malicious patterns in content
 */
export function detectMaliciousPatterns(text: string): boolean {
  const maliciousPatterns = [
    /<script/i,
    /javascript:/i,
    /on\w+\s*=/i, // Event handlers like onclick=
    /<iframe/i,
    /<object/i,
    /<embed/i,
    /eval\(/i,
    /expression\(/i, // CSS expression
    /import\s+/i,
    /document\./i,
    /window\./i
  ]

  return maliciousPatterns.some((pattern) => pattern.test(text))
}

/**
 * Full content sanitization with malicious pattern detection
 */
export function sanitizeContent(text: string): {
  sanitized: string
  isSafe: boolean
  detectedPatterns: boolean
} {
  const detectedPatterns = detectMaliciousPatterns(text)
  const sanitized = sanitizeText(text)

  return {
    sanitized,
    isSafe: !detectedPatterns,
    detectedPatterns
  }
}

/**
 * Surrogate Sanitizer Utility
 * Handles invalid UTF-16 surrogate pairs that can cause corruption
 * in signed Anthropic thinking blocks
 */

/**
 * Sanitizes lone surrogate characters in text strings
 * Uses modern String.prototype.toWellFormed() when available (Node 20+)
 * Falls back to regex replacement for older environments
 * 
 * @param {string} text - The text to sanitize
 * @returns {string} Sanitized text with lone surrogates replaced
 */
export function sanitizeSurrogates(text) {
  if (typeof text !== 'string') {
    return text;
  }

  try {
    // Modern approach: Use toWellFormed() if available (Node 20+)
    if (typeof text.toWellFormed === 'function') {
      return text.toWellFormed();
    }
  } catch (error) {
    // Fall through to regex approach
  }

  // Fallback: Regex-based approach for older Node versions
  // Replaces lone high/low surrogates with Unicode replacement character
  return text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|([^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, 
    '$1\uFFFD'
  );
}

/**
 * Validates if text contains any lone surrogate pairs
 * Useful for debugging and metrics
 * 
 * @param {string} text - The text to check
 * @returns {boolean} True if lone surrogates found
 */
export function hasLoneSurrogates(text) {
  if (typeof text !== 'string') {
    return false;
  }
  
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|([^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}
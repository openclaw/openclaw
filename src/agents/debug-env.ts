/**
 * Debug environment variable access utilities
 * Provides secure access to debug flags with environment validation
 */

/**
 * Validates if debug features should be enabled
 * Blocks debug features in production environments
 */
export function isDebugEnabled(envVarName: string): boolean {
    if (process.env.NODE_ENV === "production") {
      return false;
    }
    
    const value = process.env[envVarName];
    return value === "1" || value === "true";
  }
  
  /**
   * Lists all OpenClaw debug environment variables
   * Useful for documentation and security auditing
   */
  export const DEBUG_ENV_VARS = [
    "OPENCLAW_DEBUG_INGRESS_TIMING",
    "OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS",
    "OPENCLAW_DEBUG_TELEGRAM_INGRESS",
    "OPENCLAW_DEBUG_HEALTH",
    "OPENCLAW_DEBUG_MEMORY_EMBEDDINGS",
  ] as const;

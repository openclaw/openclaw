import type { PayloadHandler } from 'payload'

/**
 * Authentication Middleware
 * Ensures user is logged in before accessing protected endpoints
 */
export const authenticate: PayloadHandler = async (req, res, next) => {
  // Check if user is authenticated via Payload
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Please log in to access this resource'
    })
  }

  // User is authenticated, proceed
  next()
}

/**
 * Optional Authentication Middleware
 * Allows both authenticated and anonymous access but attaches user if present
 */
export const optionalAuth: PayloadHandler = async (req, res, next) => {
  // Always proceed, but user may or may not be present
  next()
}

/**
 * Admin Authorization Middleware
 * Ensures user has admin role
 */
export const requireAdmin: PayloadHandler = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required'
    })
  }

  // Check if user has admin role
  const user = req.user

  // Payload users collection typically has a 'roles' field
  // @ts-ignore - roles might not be in type definition
  if (!user.roles?.includes('admin')) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'Admin access required'
    })
  }

  next()
}

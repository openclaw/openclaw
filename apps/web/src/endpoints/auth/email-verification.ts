import type { PayloadHandler } from 'payload'
import { getEmailService } from '@/lib/email/email-service'

/**
 * Request Email Verification
 * POST /api/auth/request-verification
 *
 * Sends verification email to user
 */
export const requestEmailVerification: PayloadHandler = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        error: 'Authentication required'
      })
    }

    const user = req.user

    // Check if already verified
    // @ts-ignore
    if (user.emailVerified) {
      return res.status(400).json({
        error: 'Email already verified'
      })
    }

    // Generate verification token
    const emailService = getEmailService(req.payload)
    const token = emailService.generateVerificationToken()
    const hashedToken = emailService.hashToken(token)

    // Store hashed token and expiry
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 24) // 24 hours

    await req.payload.update({
      collection: 'users',
      id: user.id,
      data: {
        // @ts-ignore
        emailVerificationToken: hashedToken,
        emailVerificationExpires: expiresAt.toISOString()
      }
    })

    // Send verification email
    const baseUrl = `${req.protocol}://${req.headers.host}`
    const verificationUrl = `${baseUrl}/verify-email?token=${token}`

    await emailService.sendVerificationEmail({
      to: user.email,
      username: user.email.split('@')[0], // Use email prefix as username
      verificationUrl
    })

    res.json({
      success: true,
      message: 'Verification email sent. Please check your inbox.'
    })
  } catch (error: any) {
    req.payload.logger.error(`Request verification error: ${error}`)
    res.status(500).json({
      error: 'Failed to send verification email'
    })
  }
}

/**
 * Verify Email
 * POST /api/auth/verify-email
 *
 * Verifies email with token
 */
export const verifyEmail: PayloadHandler = async (req, res) => {
  try {
    const { token } = req.body

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: 'Verification token required'
      })
    }

    // Hash token for lookup
    const emailService = getEmailService(req.payload)
    const hashedToken = emailService.hashToken(token)

    // Find user with matching token
    const users = await req.payload.find({
      collection: 'users',
      where: {
        // @ts-ignore
        emailVerificationToken: {
          equals: hashedToken
        }
      },
      limit: 1
    })

    const user = users.docs[0]

    if (!user) {
      return res.status(400).json({
        error: 'Invalid or expired verification token'
      })
    }

    // Check if token expired
    // @ts-ignore
    const expiresAt = new Date(user.emailVerificationExpires)
    if (expiresAt < new Date()) {
      return res.status(400).json({
        error: 'Verification token expired. Please request a new one.'
      })
    }

    // Mark email as verified
    await req.payload.update({
      collection: 'users',
      id: user.id,
      data: {
        // @ts-ignore
        emailVerified: true,
        emailVerificationToken: null,
        emailVerificationExpires: null,
        emailVerifiedAt: new Date().toISOString()
      }
    })

    req.payload.logger.info(`Email verified for user ${user.id}`)

    res.json({
      success: true,
      message: 'Email verified successfully!'
    })
  } catch (error: any) {
    req.payload.logger.error(`Email verification error: ${error}`)
    res.status(500).json({
      error: 'Verification failed'
    })
  }
}

/**
 * Request Password Reset
 * POST /api/auth/forgot-password
 */
export const requestPasswordReset: PayloadHandler = async (req, res) => {
  try {
    const { email } = req.body

    if (!email || typeof email !== 'string') {
      return res.status(400).json({
        error: 'Email address required'
      })
    }

    // Find user by email
    const users = await req.payload.find({
      collection: 'users',
      where: {
        email: {
          equals: email.toLowerCase()
        }
      },
      limit: 1
    })

    const user = users.docs[0]

    // Don't reveal if email exists (security)
    if (!user) {
      return res.json({
        success: true,
        message: 'If that email exists, a password reset link has been sent.'
      })
    }

    // Generate reset token
    const emailService = getEmailService(req.payload)
    const token = emailService.generateVerificationToken()
    const hashedToken = emailService.hashToken(token)

    // Store hashed token and expiry
    const expiresAt = new Date()
    expiresAt.setHours(expiresAt.getHours() + 1) // 1 hour

    await req.payload.update({
      collection: 'users',
      id: user.id,
      data: {
        // @ts-ignore
        passwordResetToken: hashedToken,
        passwordResetExpires: expiresAt.toISOString()
      }
    })

    // Send password reset email
    const baseUrl = `${req.protocol}://${req.headers.host}`
    const resetUrl = `${baseUrl}/reset-password?token=${token}`

    await emailService.sendPasswordResetEmail({
      to: user.email,
      username: user.email.split('@')[0],
      resetUrl
    })

    req.payload.logger.info(`Password reset requested for user ${user.id}`)

    res.json({
      success: true,
      message: 'If that email exists, a password reset link has been sent.'
    })
  } catch (error: any) {
    req.payload.logger.error(`Password reset request error: ${error}`)
    res.status(500).json({
      error: 'Failed to process password reset request'
    })
  }
}

/**
 * Reset Password
 * POST /api/auth/reset-password
 */
export const resetPassword: PayloadHandler = async (req, res) => {
  try {
    const { token, newPassword } = req.body

    if (!token || !newPassword) {
      return res.status(400).json({
        error: 'Token and new password required'
      })
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters'
      })
    }

    // Hash token for lookup
    const emailService = getEmailService(req.payload)
    const hashedToken = emailService.hashToken(token)

    // Find user with matching token
    const users = await req.payload.find({
      collection: 'users',
      where: {
        // @ts-ignore
        passwordResetToken: {
          equals: hashedToken
        }
      },
      limit: 1
    })

    const user = users.docs[0]

    if (!user) {
      return res.status(400).json({
        error: 'Invalid or expired reset token'
      })
    }

    // Check if token expired
    // @ts-ignore
    const expiresAt = new Date(user.passwordResetExpires)
    if (expiresAt < new Date()) {
      return res.status(400).json({
        error: 'Reset token expired. Please request a new one.'
      })
    }

    // Update password
    await req.payload.update({
      collection: 'users',
      id: user.id,
      data: {
        password: newPassword, // Payload will hash it
        // @ts-ignore
        passwordResetToken: null,
        passwordResetExpires: null
      }
    })

    req.payload.logger.info(`Password reset for user ${user.id}`)

    res.json({
      success: true,
      message: 'Password reset successfully. You can now log in.'
    })
  } catch (error: any) {
    req.payload.logger.error(`Password reset error: ${error}`)
    res.status(500).json({
      error: 'Failed to reset password'
    })
  }
}

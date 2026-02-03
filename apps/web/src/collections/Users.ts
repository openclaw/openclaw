import type { CollectionConfig } from 'payload'
import { getEmailService } from '../lib/email/email-service'

export const Users: CollectionConfig = {
  slug: 'users',
  admin: {
    useAsTitle: 'email',
    defaultColumns: ['email', 'role', 'emailVerified', 'createdAt']
  },
  auth: {
    tokenExpiration: 28800, // 8 hours
    cookies: {
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax'
    },
    verify: {
      generateEmailHTML: ({ token, user }) => {
        // Custom verification email (handled by our email service)
        return `<p>Verification handled by EmailService</p>`
      }
    }
  },
  access: {
    create: ({ req: { user } }) => {
      // Only admins can create users
      return user?.role === 'admin'
    },
    read: () => true,
    update: ({ req: { user }, id }) => {
      // Users can update themselves, admins can update anyone
      if (user?.role === 'admin') return true
      return user?.id === id
    },
    delete: ({ req: { user } }) => {
      // Only admins can delete users
      return user?.role === 'admin'
    }
  },
  fields: [
    {
      name: 'email',
      type: 'email',
      required: true,
      unique: true
    },
    {
      name: 'name',
      type: 'text',
      required: false
    },
    {
      name: 'role',
      type: 'select',
      required: true,
      defaultValue: 'viewer',
      options: [
        {
          label: 'Admin',
          value: 'admin'
        },
        {
          label: 'Operator',
          value: 'operator'
        },
        {
          label: 'Viewer',
          value: 'viewer'
        }
      ],
      admin: {
        description: 'Admin: full access | Operator: manage assigned bots | Viewer: read-only'
      }
    },
    {
      name: 'assignedBots',
      type: 'relationship',
      relationTo: 'bots',
      hasMany: true,
      admin: {
        description: 'Bots this user can manage (Operators only)',
        condition: (data) => data?.role === 'operator'
      }
    },
    {
      name: 'preferences',
      type: 'json',
      admin: {
        description: 'User preferences and settings'
      }
    },
    {
      name: 'emailVerified',
      type: 'checkbox',
      defaultValue: false,
      admin: {
        description: 'Email verification status',
        readOnly: true,
        position: 'sidebar'
      }
    },
    {
      name: 'emailVerifiedAt',
      type: 'date',
      admin: {
        description: 'When email was verified',
        readOnly: true,
        position: 'sidebar',
        condition: (data) => data?.emailVerified
      }
    },
    {
      name: 'emailVerificationToken',
      type: 'text',
      admin: {
        hidden: true
      }
    },
    {
      name: 'emailVerificationExpires',
      type: 'date',
      admin: {
        hidden: true
      }
    },
    {
      name: 'passwordResetToken',
      type: 'text',
      admin: {
        hidden: true
      }
    },
    {
      name: 'passwordResetExpires',
      type: 'date',
      admin: {
        hidden: true
      }
    }
  ],
  hooks: {
    afterChange: [
      async ({ doc, operation, req }) => {
        // Send verification email on user creation
        if (operation === 'create' && !doc.emailVerified) {
          try {
            const emailService = getEmailService(req.payload)
            const token = emailService.generateVerificationToken()
            const hashedToken = emailService.hashToken(token)

            // Store hashed token and expiry
            const expiresAt = new Date()
            expiresAt.setHours(expiresAt.getHours() + 24)

            await req.payload.update({
              collection: 'users',
              id: doc.id,
              data: {
                emailVerificationToken: hashedToken,
                emailVerificationExpires: expiresAt.toISOString()
              }
            })

            // Send verification email
            const baseUrl = process.env.PAYLOAD_PUBLIC_URL || 'http://localhost:3000'
            const verificationUrl = `${baseUrl}/verify-email?token=${token}`

            await emailService.sendVerificationEmail({
              to: doc.email,
              username: doc.name || doc.email.split('@')[0],
              verificationUrl
            })

            req.payload.logger.info(`Verification email sent to ${doc.email}`)
          } catch (error) {
            req.payload.logger.error(`Failed to send verification email: ${error}`)
          }
        }
      }
    ]
  }
}

import { buildConfig } from 'payload'
import { postgresAdapter } from '@payloadcms/db-postgres'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Collections - Bot Management
import { Users } from './collections/Users'
import { Bots } from './collections/Bots'
import { BotChannels } from './collections/BotChannels'
import { BotBindings } from './collections/BotBindings'
import { Sessions } from './collections/Sessions'
import { Media } from './collections/Media'

// Collections - Social Platform
import { Profiles } from './collections/social/Profiles'
import { Posts } from './collections/social/Posts'
import { Comments } from './collections/social/Comments'
import { Likes } from './collections/social/Likes'
import { Follows } from './collections/social/Follows'
import { Notifications } from './collections/social/Notifications'

// Endpoints - Bot Management
import { startBot } from './endpoints/start-bot'
import { stopBot } from './endpoints/stop-bot'
import { restartBot } from './endpoints/restart-bot'
import { botStatus } from './endpoints/bot-status'

// Endpoints - Social Platform
import { getFeed, getProfileTimeline } from './endpoints/social/feed'
import { followProfile, unfollowProfile } from './endpoints/social/profiles'

// Endpoints - ActivityPub Federation
import {
  handleInboxRequest,
  handleSharedInboxRequest,
  getActorProfile,
  getActorOutbox,
  getActorFollowers,
  getActorFollowing
} from './endpoints/activitypub/inbox'

// Endpoints - Authentication & Email Verification
import {
  requestEmailVerification,
  verifyEmail,
  requestPasswordReset,
  resetPassword
} from './endpoints/auth/email-verification'

// Endpoints - Cache Management
import {
  getCacheStats,
  clearCache,
  warmCache
} from './endpoints/cache/stats'

// Endpoints - Blockchain (Secure)
import {
  mintBotNFT,
  listBotForSale,
  prepareBuyTransaction,
  confirmBuyTransaction,
  getBalance,
  verifySignatureEndpoint,
  getNFTMetadata,
  getMarketplaceListings
} from './endpoints/blockchain-secure'

// Endpoints - Webhooks (Incoming Messages)
import { handleTelegramWebhook, setTelegramWebhook } from './endpoints/webhooks/telegram'
import { handleDiscordWebhook } from './endpoints/webhooks/discord'
import { handleSlackWebhook } from './endpoints/webhooks/slack'

// Endpoints - Gateway Communication
import { deliverResponse } from './endpoints/gateway/deliver-response'

// Middleware - Security
import { authenticate, requireAdmin } from './middleware/authenticate'
import {
  authorizeBotOwnership,
  authorizeProfileOwnership,
  blockchainRateLimit,
  socialActionRateLimit,
  botManagementRateLimit
} from './middleware/authorize'
import { verifyCsrfToken, generateCsrfToken } from './middleware/csrf'
import {
  validateBlockchainRequest,
  validateSocialPost,
  sanitizeQueryParams,
  validatePagination
} from './middleware/validation'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname)
    }
  },
  collections: [
    // Bot Management
    Users,
    Bots,
    BotChannels,
    BotBindings,
    Sessions,
    Media,

    // Social Platform
    Profiles,
    Posts,
    Comments,
    Likes,
    Follows,
    Notifications
  ],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || 'your-secret-key-change-in-production',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts')
  },
  db: postgresAdapter({
    pool: {
      connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/openclaw'
    }
  }),
  endpoints: [
    // Security - CSRF Token Generation
    {
      path: '/csrf-token',
      method: 'get',
      handler: generateCsrfToken
    },

    // Security - Signature Verification Utility
    {
      path: '/verify-signature',
      method: 'post',
      handler: verifySignatureEndpoint
    },

    // Authentication - Email Verification
    {
      path: '/auth/request-verification',
      method: 'post',
      handler: [authenticate, requestEmailVerification]
    },
    {
      path: '/auth/verify-email',
      method: 'post',
      handler: verifyEmail
    },
    {
      path: '/auth/forgot-password',
      method: 'post',
      handler: requestPasswordReset
    },
    {
      path: '/auth/reset-password',
      method: 'post',
      handler: resetPassword
    },

    // Cache Management (admin only)
    {
      path: '/cache/stats',
      method: 'get',
      handler: [requireAdmin, getCacheStats]
    },
    {
      path: '/cache/clear',
      method: 'post',
      handler: [requireAdmin, verifyCsrfToken, clearCache]
    },
    {
      path: '/cache/warm',
      method: 'post',
      handler: [requireAdmin, verifyCsrfToken, warmCache]
    },

    // Bot Management (with authentication, authorization, and rate limiting)
    {
      path: '/start-bot',
      method: 'post',
      handler: [
        authenticate,
        authorizeBotOwnership,
        botManagementRateLimit,
        verifyCsrfToken,
        startBot
      ]
    },
    {
      path: '/stop-bot',
      method: 'post',
      handler: [
        authenticate,
        authorizeBotOwnership,
        botManagementRateLimit,
        verifyCsrfToken,
        stopBot
      ]
    },
    {
      path: '/restart-bot',
      method: 'post',
      handler: [
        authenticate,
        authorizeBotOwnership,
        botManagementRateLimit,
        verifyCsrfToken,
        restartBot
      ]
    },
    {
      path: '/bot-status',
      method: 'get',
      handler: [sanitizeQueryParams, validatePagination, botStatus]
    },

    // Social Platform (with authentication and rate limiting)
    {
      path: '/social/feed',
      method: 'get',
      handler: [sanitizeQueryParams, validatePagination, getFeed]
    },
    {
      path: '/social/profiles/:username/timeline',
      method: 'get',
      handler: [sanitizeQueryParams, validatePagination, getProfileTimeline]
    },
    {
      path: '/social/profiles/:id/follow',
      method: 'post',
      handler: [
        authenticate,
        socialActionRateLimit,
        verifyCsrfToken,
        followProfile
      ]
    },
    {
      path: '/social/profiles/:id/follow',
      method: 'delete',
      handler: [
        authenticate,
        socialActionRateLimit,
        verifyCsrfToken,
        unfollowProfile
      ]
    },

    // Blockchain - NFT and Marketplace (SECURE - No private keys!)
    {
      path: '/blockchain-secure/mint-nft',
      method: 'post',
      handler: [
        authenticate,
        authorizeBotOwnership,
        blockchainRateLimit,
        validateBlockchainRequest,
        verifyCsrfToken,
        mintBotNFT
      ]
    },
    {
      path: '/blockchain-secure/list-sale',
      method: 'post',
      handler: [
        authenticate,
        authorizeBotOwnership,
        blockchainRateLimit,
        validateBlockchainRequest,
        verifyCsrfToken,
        listBotForSale
      ]
    },
    {
      path: '/blockchain-secure/prepare-buy',
      method: 'post',
      handler: [
        authenticate,
        blockchainRateLimit,
        validateBlockchainRequest,
        prepareBuyTransaction
      ]
    },
    {
      path: '/blockchain-secure/confirm-buy',
      method: 'post',
      handler: [
        authenticate,
        blockchainRateLimit,
        validateBlockchainRequest,
        verifyCsrfToken,
        confirmBuyTransaction
      ]
    },
    {
      path: '/blockchain-secure/balance',
      method: 'get',
      handler: [sanitizeQueryParams, getBalance]
    },
    {
      path: '/blockchain-secure/nft-metadata',
      method: 'get',
      handler: [sanitizeQueryParams, getNFTMetadata]
    },
    {
      path: '/blockchain-secure/marketplace/listings',
      method: 'get',
      handler: [sanitizeQueryParams, validatePagination, getMarketplaceListings]
    },

    // ActivityPub Federation Endpoints
    {
      path: '/ap/users/:username',
      method: 'get',
      handler: getActorProfile
    },
    {
      path: '/ap/users/:username/inbox',
      method: 'post',
      handler: handleInboxRequest
    },
    {
      path: '/ap/inbox',
      method: 'post',
      handler: handleSharedInboxRequest
    },
    {
      path: '/ap/users/:username/outbox',
      method: 'get',
      handler: [sanitizeQueryParams, getActorOutbox]
    },
    {
      path: '/ap/users/:username/followers',
      method: 'get',
      handler: getActorFollowers
    },
    {
      path: '/ap/users/:username/following',
      method: 'get',
      handler: getActorFollowing
    },

    // Webhooks - Incoming Messages from Chat Platforms
    {
      path: '/webhooks/telegram/:accountId?',
      method: 'post',
      handler: handleTelegramWebhook
    },
    {
      path: '/webhooks/telegram/setup',
      method: 'post',
      handler: [authenticate, requireAdmin, setTelegramWebhook]
    },
    {
      path: '/webhooks/discord/:accountId?',
      method: 'post',
      handler: handleDiscordWebhook
    },
    {
      path: '/webhooks/slack/:accountId?',
      method: 'post',
      handler: handleSlackWebhook
    },

    // Gateway Communication - Response Delivery
    {
      path: '/gateway/deliver-response',
      method: 'post',
      handler: deliverResponse
    }
  ],
  sharp: true
})

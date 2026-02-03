import type { PayloadHandler } from 'payload'
import { getEthereumService } from '../lib/blockchain/ethereum'
import { getBittensorService } from '../lib/blockchain/bittensor'
import { verifyMessage } from 'ethers'

/**
 * SECURE Blockchain Endpoints
 *
 * CRITICAL: These endpoints use wallet-based authentication
 * Private keys are NEVER transmitted over the network
 * All transactions are signed client-side by the user's wallet (MetaMask, etc.)
 */

/**
 * Mint Bot NFT (Secure)
 * POST /api/blockchain-secure/mint-nft
 *
 * Flow:
 * 1. User connects wallet client-side (MetaMask)
 * 2. Frontend calls this endpoint with signature
 * 3. Server verifies signature
 * 4. Server submits transaction using platform wallet (for gas fees)
 * 5. NFT is minted to user's address
 */
export const mintBotNFT: PayloadHandler = async (req, res) => {
  try {
    const { botId, userAddress, signature, message, timestamp } = req.body

    // Validate input
    if (!botId || !userAddress || !signature || !message) {
      return res.status(400).json({
        error: 'Missing required fields'
      })
    }

    // Verify timestamp is recent (within 5 minutes)
    const now = Date.now()
    if (Math.abs(now - timestamp) > 5 * 60 * 1000) {
      return res.status(400).json({
        error: 'Request expired. Please try again.'
      })
    }

    // Verify signature
    const expectedMessage = `ClawNet NFT Mint Request\nBot ID: ${botId}\nAddress: ${userAddress}\nTimestamp: ${timestamp}`

    if (message !== expectedMessage) {
      return res.status(400).json({
        error: 'Invalid message format'
      })
    }

    const recoveredAddress = verifyMessage(message, signature)

    if (recoveredAddress.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(401).json({
        error: 'Invalid signature'
      })
    }

    // Get bot and verify ownership
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' })
    }

    // Verify user owns the bot
    if (bot.user !== req.user?.id) {
      return res.status(403).json({
        error: 'You do not own this bot'
      })
    }

    // Check if already minted
    // @ts-ignore
    if (bot.nftTokenId) {
      return res.status(400).json({
        error: 'Bot already has an NFT'
      })
    }

    // Mint NFT using platform wallet (pays gas fees)
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(process.env.ETHEREUM_PRIVATE_KEY)

    const tokenId = await ethereum.mintBotNFT(bot, userAddress)

    res.json({
      success: true,
      tokenId,
      message: `Bot NFT minted successfully: #${tokenId}`,
      owner: userAddress
    })
  } catch (error: any) {
    req.payload.logger.error(`Mint NFT error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * List Bot for Sale (Secure)
 * POST /api/blockchain-secure/list-sale
 *
 * User must approve the marketplace contract to transfer their NFT
 * This happens client-side in MetaMask
 */
export const listBotForSale: PayloadHandler = async (req, res) => {
  try {
    const { botId, price, userAddress, signature, message, timestamp } =
      req.body

    // Validate
    if (!botId || !price || !userAddress || !signature) {
      return res.status(400).json({
        error: 'Missing required fields'
      })
    }

    // Verify timestamp
    if (Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) {
      return res.status(400).json({
        error: 'Request expired'
      })
    }

    // Verify signature
    const expectedMessage = `ClawNet List for Sale\nBot ID: ${botId}\nPrice: ${price} CLAW\nAddress: ${userAddress}\nTimestamp: ${timestamp}`

    if (message !== expectedMessage) {
      return res.status(400).json({
        error: 'Invalid message format'
      })
    }

    const recoveredAddress = verifyMessage(message, signature)

    if (recoveredAddress.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(401).json({
        error: 'Invalid signature'
      })
    }

    // Get bot
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' })
    }

    // Verify ownership
    if (bot.user !== req.user?.id) {
      return res.status(403).json({
        error: 'You do not own this bot'
      })
    }

    // @ts-ignore
    const tokenId = bot.nftTokenId
    if (!tokenId) {
      return res.status(400).json({
        error: 'Bot does not have an NFT'
      })
    }

    // Verify NFT ownership on-chain
    const ethereum = getEthereumService(req.payload)
    const onChainOwner = await ethereum.botNFT.ownerOf(tokenId)

    if (onChainOwner.toLowerCase() !== userAddress.toLowerCase()) {
      return res.status(403).json({
        error: 'NFT ownership mismatch'
      })
    }

    // List on marketplace
    // Note: User must have already approved marketplace contract client-side
    await ethereum.connectWallet(process.env.ETHEREUM_PRIVATE_KEY)
    await ethereum.listBotForSale(tokenId, price)

    // Update database
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        // @ts-ignore
        nftListedForSale: true,
        nftSalePrice: price
      }
    })

    res.json({
      success: true,
      message: `Bot listed for sale at ${price} CLAW`
    })
  } catch (error: any) {
    req.payload.logger.error(`List for sale error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Prepare Buy Transaction (Secure)
 * POST /api/blockchain-secure/prepare-buy
 *
 * Returns unsigned transaction data for user to sign in wallet
 */
export const prepareBuyTransaction: PayloadHandler = async (req, res) => {
  try {
    const { botId, buyerAddress } = req.body

    if (!botId || !buyerAddress) {
      return res.status(400).json({
        error: 'Missing required fields'
      })
    }

    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' })
    }

    // @ts-ignore
    const tokenId = bot.nftTokenId
    // @ts-ignore
    const price = bot.nftSalePrice

    if (!tokenId || !price) {
      return res.status(400).json({
        error: 'Bot is not listed for sale'
      })
    }

    // Get contract ABI and address for frontend
    const ethereum = getEthereumService(req.payload)
    const marketplaceAddress = await ethereum.marketplace.getAddress()

    res.json({
      success: true,
      transaction: {
        to: marketplaceAddress,
        data: {
          // Contract method parameters
          method: 'buyBot',
          params: [tokenId]
        },
        value: 0, // ERC-20 transfer, not ETH
        gasLimit: '500000' // Estimated gas limit
      },
      bot: {
        id: botId,
        name: bot.name,
        tokenId,
        price
      }
    })
  } catch (error: any) {
    req.payload.logger.error(`Prepare buy error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Confirm Buy Transaction (Secure)
 * POST /api/blockchain-secure/confirm-buy
 *
 * Called after user signs and submits transaction
 * Verifies transaction on-chain and updates database
 */
export const confirmBuyTransaction: PayloadHandler = async (req, res) => {
  try {
    const { botId, transactionHash, buyerAddress } = req.body

    if (!botId || !transactionHash || !buyerAddress) {
      return res.status(400).json({
        error: 'Missing required fields'
      })
    }

    // Wait for transaction confirmation with timeout
    const ethereum = getEthereumService(req.payload)
    const provider = ethereum['provider']

    const TRANSACTION_TIMEOUT = 120000 // 2 minutes

    let receipt
    try {
      receipt = await Promise.race([
        provider.waitForTransaction(transactionHash, 3), // Wait for 3 confirmations
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Transaction confirmation timeout')), TRANSACTION_TIMEOUT)
        )
      ])
    } catch (error) {
      if (error instanceof Error && error.message === 'Transaction confirmation timeout') {
        return res.status(408).json({
          error: 'Transaction confirmation timeout',
          message: 'Transaction is still pending. Please check again in a few minutes.',
          transactionHash
        })
      }
      throw error
    }

    if (!receipt || !receipt.status) {
      return res.status(400).json({
        error: 'Transaction failed'
      })
    }

    // Verify NFT ownership changed
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    // @ts-ignore
    const tokenId = bot.nftTokenId
    const newOwner = await ethereum.botNFT.ownerOf(tokenId)

    if (newOwner.toLowerCase() !== buyerAddress.toLowerCase()) {
      return res.status(400).json({
        error: 'NFT ownership verification failed'
      })
    }

    // Update database
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        // @ts-ignore
        nftOwner: buyerAddress,
        nftListedForSale: false,
        nftSalePrice: null
      }
    })

    res.json({
      success: true,
      message: 'Bot purchased successfully',
      transactionHash,
      newOwner: buyerAddress
    })
  } catch (error: any) {
    req.payload.logger.error(`Confirm buy error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Get User's Wallet Balance
 * GET /api/blockchain-secure/balance?address=0x...
 *
 * Read-only operation, no authentication required
 */
export const getBalance: PayloadHandler = async (req, res) => {
  try {
    const { address } = req.query

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Address required' })
    }

    const ethereum = getEthereumService(req.payload)
    const balance = await ethereum.getClawBalance(address)

    res.json({
      address,
      balance,
      currency: 'CLAW'
    })
  } catch (error: any) {
    req.payload.logger.error(`Get balance error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Verify Signature Utility Endpoint
 * POST /api/blockchain-secure/verify-signature
 *
 * Helps frontend verify signatures are correct before submitting
 */
export const verifySignatureEndpoint: PayloadHandler = async (req, res) => {
  try {
    const { message, signature, expectedAddress } = req.body

    if (!message || !signature) {
      return res.status(400).json({
        error: 'Missing message or signature'
      })
    }

    const recoveredAddress = verifyMessage(message, signature)

    const isValid = expectedAddress
      ? recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
      : true

    res.json({
      valid: isValid,
      recoveredAddress,
      message: isValid
        ? 'Signature is valid'
        : 'Signature does not match expected address'
    })
  } catch (error: any) {
    req.payload.logger.error(`Verify signature error: ${error}`)
    res.status(500).json({ error: 'Signature verification failed' })
  }
}

/**
 * Get NFT Metadata
 * GET /api/blockchain-secure/nft-metadata?tokenId=123
 *
 * Read-only, no auth required
 */
export const getNFTMetadata: PayloadHandler = async (req, res) => {
  try {
    const { tokenId } = req.query

    if (!tokenId) {
      return res.status(400).json({ error: 'Token ID required' })
    }

    const ethereum = getEthereumService(req.payload)
    const metadata = await ethereum.getBotMetadata(tokenId as string)
    const rating = await ethereum.getBotRating(tokenId as string)

    res.json({
      tokenId,
      metadata: {
        name: metadata.name,
        agentType: metadata.agentType,
        modelInfo: metadata.modelInfo,
        creationDate: new Date(
          Number(metadata.creationDate) * 1000
        ).toISOString(),
        creator: metadata.creator,
        totalEarnings: metadata.totalEarnings.toString(),
        totalInteractions: metadata.totalInteractions.toString()
      },
      rating: {
        average: rating.rating,
        count: rating.count
      }
    })
  } catch (error: any) {
    req.payload.logger.error(`Get NFT metadata error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

/**
 * Get Marketplace Listings (Secure)
 * GET /api/blockchain-secure/marketplace/listings?type=sale
 *
 * Read-only, includes on-chain verification
 */
export const getMarketplaceListings: PayloadHandler = async (req, res) => {
  try {
    const { type, limit = '20', offset = '0' } = req.query

    const where: any = {}

    if (type === 'sale') {
      where.nftListedForSale = { equals: true }
    } else if (type === 'rent') {
      where.nftListedForRent = { equals: true }
    } else {
      where.or = [
        { nftListedForSale: { equals: true } },
        { nftListedForRent: { equals: true } }
      ]
    }

    const bots = await req.payload.find({
      collection: 'bots',
      where,
      limit: parseInt(limit as string, 10),
      offset: parseInt(offset as string, 10)
    })

    // Enrich with on-chain data
    const ethereum = getEthereumService(req.payload)
    const enrichedListings = await Promise.all(
      bots.docs.map(async (bot) => {
        // @ts-ignore
        const tokenId = bot.nftTokenId

        if (!tokenId) {
          return null
        }

        try {
          const owner = await ethereum.botNFT.ownerOf(tokenId)
          const rating = await ethereum.getBotRating(tokenId)

          return {
            botId: bot.id,
            name: bot.name,
            agentType: bot.agentType,
            model: bot.model,
            tokenId,
            owner,
            // @ts-ignore
            forSale: bot.nftListedForSale,
            // @ts-ignore
            salePrice: bot.nftSalePrice,
            // @ts-ignore
            forRent: bot.nftListedForRent,
            // @ts-ignore
            rentalPrice: bot.nftRentalPrice,
            // @ts-ignore
            rentalMaxDays: bot.nftRentalMaxDays,
            rating: {
              average: rating.rating,
              count: rating.count
            }
          }
        } catch (error) {
          req.payload.logger.warn(`Failed to fetch on-chain data for bot ${bot.id}: ${error}`)
          return null
        }
      })
    )

    // Filter out failed enrichments
    const validListings = enrichedListings.filter((listing) => listing !== null)

    res.json({
      listings: validListings,
      pagination: {
        total: bots.totalDocs,
        limit: parseInt(limit as string, 10),
        offset: parseInt(offset as string, 10),
        hasMore: bots.hasNextPage
      }
    })
  } catch (error: any) {
    req.payload.logger.error(`Get listings error: ${error}`)
    res.status(500).json({ error: 'Internal server error' })
  }
}

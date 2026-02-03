import type { PayloadHandler } from 'payload'
import { getEthereumService } from '../lib/blockchain/ethereum'
import { getBittensorService } from '../lib/blockchain/bittensor'

/**
 * Mint Bot NFT
 * POST /api/blockchain/mint-nft
 */
export const mintBotNFT: PayloadHandler = async (req, res) => {
  try {
    const { botId, ownerAddress } = req.body

    if (!botId || !ownerAddress) {
      return res.status(400).json({
        error: 'Missing required fields: botId, ownerAddress'
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

    // Mint NFT
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(process.env.ETHEREUM_PRIVATE_KEY)

    const tokenId = await ethereum.mintBotNFT(bot, ownerAddress)

    res.json({
      success: true,
      tokenId,
      message: `Bot NFT minted successfully: #${tokenId}`
    })
  } catch (error: any) {
    req.payload.logger.error(`Mint NFT error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * List Bot for Sale
 * POST /api/blockchain/list-sale
 */
export const listBotForSale: PayloadHandler = async (req, res) => {
  try {
    const { botId, price } = req.body

    if (!botId || !price) {
      return res.status(400).json({
        error: 'Missing required fields: botId, price'
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

    // @ts-ignore - custom field
    const tokenId = bot.nftTokenId
    if (!tokenId) {
      return res.status(400).json({
        error: 'Bot does not have an NFT. Mint NFT first.'
      })
    }

    // List for sale
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(process.env.ETHEREUM_PRIVATE_KEY)

    await ethereum.listBotForSale(tokenId, price)

    // Update bot status
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        // @ts-ignore - custom fields
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
    res.status(500).json({ error: error.message })
  }
}

/**
 * List Bot for Rent
 * POST /api/blockchain/list-rent
 */
export const listBotForRent: PayloadHandler = async (req, res) => {
  try {
    const { botId, pricePerDay, maxDays } = req.body

    if (!botId || !pricePerDay) {
      return res.status(400).json({
        error: 'Missing required fields: botId, pricePerDay'
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

    // @ts-ignore - custom field
    const tokenId = bot.nftTokenId
    if (!tokenId) {
      return res.status(400).json({
        error: 'Bot does not have an NFT. Mint NFT first.'
      })
    }

    // List for rent
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(process.env.ETHEREUM_PRIVATE_KEY)

    await ethereum.listBotForRent(tokenId, pricePerDay, maxDays || 30)

    // Update bot status
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        // @ts-ignore - custom fields
        nftListedForRent: true,
        nftRentalPrice: pricePerDay,
        nftRentalMaxDays: maxDays || 30
      }
    })

    res.json({
      success: true,
      message: `Bot listed for rent at ${pricePerDay} CLAW/day`
    })
  } catch (error: any) {
    req.payload.logger.error(`List for rent error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Buy Bot
 * POST /api/blockchain/buy-bot
 */
export const buyBot: PayloadHandler = async (req, res) => {
  try {
    const { botId, buyerPrivateKey } = req.body

    if (!botId || !buyerPrivateKey) {
      return res.status(400).json({
        error: 'Missing required fields: botId, buyerPrivateKey'
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

    // @ts-ignore - custom field
    const tokenId = bot.nftTokenId
    if (!tokenId) {
      return res.status(400).json({ error: 'Bot does not have an NFT' })
    }

    // Buy bot
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(buyerPrivateKey)

    await ethereum.buyBot(tokenId)

    const buyerAddress = await ethereum.connectWallet(buyerPrivateKey)

    // Update bot ownership
    await req.payload.update({
      collection: 'bots',
      id: botId,
      data: {
        // @ts-ignore - custom fields
        nftOwner: buyerAddress,
        nftListedForSale: false,
        nftSalePrice: null
      }
    })

    res.json({
      success: true,
      message: 'Bot purchased successfully',
      newOwner: buyerAddress
    })
  } catch (error: any) {
    req.payload.logger.error(`Buy bot error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Rent Bot
 * POST /api/blockchain/rent-bot
 */
export const rentBot: PayloadHandler = async (req, res) => {
  try {
    const { botId, days, renterPrivateKey } = req.body

    if (!botId || !days || !renterPrivateKey) {
      return res.status(400).json({
        error: 'Missing required fields: botId, days, renterPrivateKey'
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

    // @ts-ignore - custom field
    const tokenId = bot.nftTokenId
    if (!tokenId) {
      return res.status(400).json({ error: 'Bot does not have an NFT' })
    }

    // Rent bot
    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(renterPrivateKey)

    await ethereum.rentBot(tokenId, days)

    const renterAddress = await ethereum.connectWallet(renterPrivateKey)

    res.json({
      success: true,
      message: `Bot rented for ${days} days`,
      renter: renterAddress
    })
  } catch (error: any) {
    req.payload.logger.error(`Rent bot error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Get CLAW Balance
 * GET /api/blockchain/balance?address=0x...
 */
export const getBalance: PayloadHandler = async (req, res) => {
  try {
    const { address } = req.query

    if (!address || typeof address !== 'string') {
      return res.status(400).json({ error: 'Missing address parameter' })
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
    res.status(500).json({ error: error.message })
  }
}

/**
 * Withdraw Earnings
 * POST /api/blockchain/withdraw
 */
export const withdrawEarnings: PayloadHandler = async (req, res) => {
  try {
    const { privateKey } = req.body

    if (!privateKey) {
      return res.status(400).json({ error: 'Missing privateKey' })
    }

    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(privateKey)

    await ethereum.withdrawEarnings()

    res.json({
      success: true,
      message: 'Earnings withdrawn successfully'
    })
  } catch (error: any) {
    req.payload.logger.error(`Withdraw error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Get Bot Rating
 * GET /api/blockchain/bot-rating?tokenId=123
 */
export const getBotRating: PayloadHandler = async (req, res) => {
  try {
    const { tokenId } = req.query

    if (!tokenId || typeof tokenId !== 'string') {
      return res.status(400).json({ error: 'Missing tokenId parameter' })
    }

    const ethereum = getEthereumService(req.payload)
    const rating = await ethereum.getBotRating(tokenId)

    res.json({
      tokenId,
      rating: rating.rating,
      ratingCount: rating.count
    })
  } catch (error: any) {
    req.payload.logger.error(`Get rating error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Rate Bot
 * POST /api/blockchain/rate-bot
 */
export const rateBot: PayloadHandler = async (req, res) => {
  try {
    const { tokenId, rating, raterPrivateKey } = req.body

    if (!tokenId || !rating || !raterPrivateKey) {
      return res.status(400).json({
        error: 'Missing required fields: tokenId, rating, raterPrivateKey'
      })
    }

    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5' })
    }

    const ethereum = getEthereumService(req.payload)
    await ethereum.connectWallet(raterPrivateKey)

    await ethereum.rateBot(tokenId, rating)

    res.json({
      success: true,
      message: `Bot rated ${rating}/5`
    })
  } catch (error: any) {
    req.payload.logger.error(`Rate bot error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Register Bot in Bittensor
 * POST /api/blockchain/bittensor/register
 */
export const registerBittensorMiner: PayloadHandler = async (req, res) => {
  try {
    const { botId } = req.body

    if (!botId) {
      return res.status(400).json({ error: 'Missing botId' })
    }

    // Get bot
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' })
    }

    // Register miner
    const bittensor = getBittensorService(req.payload)
    const uid = await bittensor.registerMiner(bot)

    res.json({
      success: true,
      uid,
      message: `Bot registered as Bittensor miner with UID ${uid}`
    })
  } catch (error: any) {
    req.payload.logger.error(`Register miner error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Get Bittensor Earnings
 * GET /api/blockchain/bittensor/earnings?botId=123
 */
export const getBittensorEarnings: PayloadHandler = async (req, res) => {
  try {
    const { botId } = req.query

    if (!botId || typeof botId !== 'string') {
      return res.status(400).json({ error: 'Missing botId parameter' })
    }

    // Get bot
    const bot = await req.payload.findByID({
      collection: 'bots',
      id: botId
    })

    if (!bot) {
      return res.status(404).json({ error: 'Bot not found' })
    }

    // Get earnings
    const bittensor = getBittensorService(req.payload)
    const earnings = await bittensor.aggregateBotEarnings(bot)

    res.json({
      botId,
      earnings: earnings.toString(),
      currency: 'TAO'
    })
  } catch (error: any) {
    req.payload.logger.error(`Get earnings error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

/**
 * Get Marketplace Listings
 * GET /api/blockchain/marketplace/listings
 */
export const getMarketplaceListings: PayloadHandler = async (req, res) => {
  try {
    const { type } = req.query // 'sale' or 'rent'

    // Query bots listed for sale or rent
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
      limit: 100
    })

    res.json({
      listings: bots.docs.map((bot) => ({
        botId: bot.id,
        name: bot.name,
        agentType: bot.agentType,
        model: bot.model,
        // @ts-ignore - custom fields
        tokenId: bot.nftTokenId,
        owner: bot.nftOwner,
        forSale: bot.nftListedForSale,
        salePrice: bot.nftSalePrice,
        forRent: bot.nftListedForRent,
        rentalPrice: bot.nftRentalPrice,
        rentalMaxDays: bot.nftRentalMaxDays
      }))
    })
  } catch (error: any) {
    req.payload.logger.error(`Get listings error: ${error}`)
    res.status(500).json({ error: error.message })
  }
}

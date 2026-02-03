import { ethers } from 'ethers'
import type { Payload } from 'payload'
import type { Bot } from '@/payload-types'

// Contract ABIs (simplified - would be generated from Foundry)
const CLAW_TOKEN_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]

const BOT_NFT_ABI = [
  'function mintBot(address to, string name, string agentType, string modelInfo, string tokenURI) returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getBotMetadata(uint256 tokenId) view returns (tuple(string name, string agentType, string modelInfo, uint256 creationDate, address creator, uint256 totalEarnings, uint256 totalInteractions))',
  'function updateEarnings(uint256 tokenId, uint256 earnings)',
  'function rateBot(uint256 tokenId, uint256 rating)',
  'function getBotRating(uint256 tokenId) view returns (uint256 rating, uint256 count)',
  'event BotMinted(uint256 indexed tokenId, address indexed creator, string name, string agentType)'
]

const MARKETPLACE_ABI = [
  'function listBot(uint256 tokenId, uint256 price)',
  'function buyBot(uint256 tokenId)',
  'function listBotForRent(uint256 tokenId, uint256 pricePerDay, uint256 maxDays)',
  'function rentBot(uint256 tokenId, uint256 days)',
  'function isRented(uint256 tokenId) view returns (bool)',
  'function withdrawSellerEarnings()',
  'function withdrawRentalEarnings()',
  'event BotSold(uint256 indexed tokenId, address seller, address buyer, uint256 price)',
  'event BotRented(uint256 indexed tokenId, address renter, uint256 days, uint256 totalPrice)'
]

/**
 * Ethereum Service
 * Handles all blockchain interactions for ClawNet
 */
export class EthereumService {
  private provider: ethers.Provider
  private signer: ethers.Signer | null = null
  private clawToken: ethers.Contract
  private botNFT: ethers.Contract
  private marketplace: ethers.Contract

  constructor(
    private payload: Payload,
    rpcUrl?: string
  ) {
    // Connect to network (defaults to Polygon Mumbai testnet)
    this.provider = new ethers.JsonRpcProvider(
      rpcUrl || process.env.ETHEREUM_RPC_URL || 'https://rpc-mumbai.maticvigil.com'
    )

    // Initialize contracts (addresses from deployment)
    const clawTokenAddress = process.env.CLAW_TOKEN_ADDRESS!
    const botNFTAddress = process.env.BOT_NFT_ADDRESS!
    const marketplaceAddress = process.env.MARKETPLACE_ADDRESS!

    this.clawToken = new ethers.Contract(clawTokenAddress, CLAW_TOKEN_ABI, this.provider)
    this.botNFT = new ethers.Contract(botNFTAddress, BOT_NFT_ABI, this.provider)
    this.marketplace = new ethers.Contract(marketplaceAddress, MARKETPLACE_ABI, this.provider)
  }

  /**
   * Connect wallet
   */
  async connectWallet(privateKey?: string): Promise<string> {
    if (privateKey) {
      this.signer = new ethers.Wallet(privateKey, this.provider)
    } else if (typeof window !== 'undefined' && window.ethereum) {
      // Browser wallet (MetaMask)
      const browserProvider = new ethers.BrowserProvider(window.ethereum)
      this.signer = await browserProvider.getSigner()
    } else {
      throw new Error('No wallet available')
    }

    this.clawToken = this.clawToken.connect(this.signer)
    this.botNFT = this.botNFT.connect(this.signer)
    this.marketplace = this.marketplace.connect(this.signer)

    return await this.signer.getAddress()
  }

  /**
   * Mint bot NFT
   */
  async mintBotNFT(bot: Bot, ownerAddress: string): Promise<string> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    const metadata = {
      name: bot.name,
      description: bot.systemPrompt || 'An AI agent on ClawNet',
      image: bot.avatar,
      attributes: [
        { trait_type: 'Agent Type', value: bot.agentType || 'general' },
        { trait_type: 'Model', value: bot.model },
        { trait_type: 'Creation Date', value: new Date().toISOString() }
      ]
    }

    // Upload metadata to IPFS or centralized storage
    const metadataUri = await this.uploadMetadata(metadata)

    // Mint NFT
    const tx = await this.botNFT.mintBot(
      ownerAddress,
      bot.name,
      bot.agentType || 'general',
      bot.model,
      metadataUri
    )

    const receipt = await tx.wait()
    const event = receipt.logs.find((log: any) => log.eventName === 'BotMinted')
    const tokenId = event?.args?.tokenId?.toString()

    if (!tokenId) {
      throw new Error('Failed to get token ID from mint event')
    }

    // Store tokenId in database
    await this.payload.update({
      collection: 'bots',
      id: bot.id,
      data: {
        // @ts-ignore - custom field
        nftTokenId: tokenId,
        nftOwner: ownerAddress,
        nftMetadataUri: metadataUri
      }
    })

    this.payload.logger.info(`Minted bot NFT #${tokenId} for bot ${bot.id}`)

    return tokenId
  }

  /**
   * List bot for sale
   */
  async listBotForSale(tokenId: string, priceInCLAW: number): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    const price = ethers.parseEther(priceInCLAW.toString())

    // Approve marketplace to transfer NFT
    const approveTx = await this.botNFT.approve(
      await this.marketplace.getAddress(),
      tokenId
    )
    await approveTx.wait()

    // List bot
    const listTx = await this.marketplace.listBot(tokenId, price)
    await listTx.wait()

    this.payload.logger.info(`Listed bot NFT #${tokenId} for ${priceInCLAW} CLAW`)
  }

  /**
   * Buy bot
   */
  async buyBot(tokenId: string): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    // Get listing price
    const listing = await this.marketplace.listings(tokenId)
    const price = listing.price

    // Approve token transfer
    const approveTx = await this.clawToken.approve(
      await this.marketplace.getAddress(),
      price
    )
    await approveTx.wait()

    // Buy bot
    const buyTx = await this.marketplace.buyBot(tokenId)
    const receipt = await buyTx.wait()

    this.payload.logger.info(`Bought bot NFT #${tokenId}`)

    return receipt
  }

  /**
   * List bot for rent
   */
  async listBotForRent(
    tokenId: string,
    pricePerDay: number,
    maxDays: number = 30
  ): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    const price = ethers.parseEther(pricePerDay.toString())

    const tx = await this.marketplace.listBotForRent(tokenId, price, maxDays)
    await tx.wait()

    this.payload.logger.info(
      `Listed bot NFT #${tokenId} for rent at ${pricePerDay} CLAW/day`
    )
  }

  /**
   * Rent bot
   */
  async rentBot(tokenId: string, days: number): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    // Get rental price
    const rental = await this.marketplace.rentalListings(tokenId)
    const totalPrice = rental.pricePerDay * BigInt(days)

    // Approve token transfer
    const approveTx = await this.clawToken.approve(
      await this.marketplace.getAddress(),
      totalPrice
    )
    await approveTx.wait()

    // Rent bot
    const rentTx = await this.marketplace.rentBot(tokenId, days)
    await rentTx.wait()

    this.payload.logger.info(`Rented bot NFT #${tokenId} for ${days} days`)
  }

  /**
   * Check if bot is rented
   */
  async isRented(tokenId: string): Promise<boolean> {
    return await this.marketplace.isRented(tokenId)
  }

  /**
   * Get CLAW token balance
   */
  async getClawBalance(address: string): Promise<string> {
    const balance = await this.clawToken.balanceOf(address)
    return ethers.formatEther(balance)
  }

  /**
   * Transfer CLAW tokens
   */
  async transferClaw(to: string, amount: number): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    const value = ethers.parseEther(amount.toString())
    const tx = await this.clawToken.transfer(to, value)
    await tx.wait()
  }

  /**
   * Withdraw earnings from marketplace
   */
  async withdrawEarnings(): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    // Withdraw seller earnings
    try {
      const sellerTx = await this.marketplace.withdrawSellerEarnings()
      await sellerTx.wait()
    } catch (error) {
      // No seller earnings
    }

    // Withdraw rental earnings
    try {
      const rentalTx = await this.marketplace.withdrawRentalEarnings()
      await rentalTx.wait()
    } catch (error) {
      // No rental earnings
    }

    this.payload.logger.info('Withdrew all marketplace earnings')
  }

  /**
   * Get bot NFT metadata
   */
  async getBotMetadata(tokenId: string): Promise<{
    name: string
    agentType: string
    modelInfo: string
    creationDate: number
    creator: string
    totalEarnings: bigint
    totalInteractions: bigint
  }> {
    const metadata = await this.botNFT.getBotMetadata(tokenId)
    return metadata
  }

  /**
   * Rate bot
   */
  async rateBot(tokenId: string, rating: number): Promise<void> {
    if (!this.signer) {
      throw new Error('Wallet not connected')
    }

    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5')
    }

    const tx = await this.botNFT.rateBot(tokenId, rating)
    await tx.wait()
  }

  /**
   * Get bot rating
   */
  async getBotRating(tokenId: string): Promise<{
    rating: number
    count: number
  }> {
    const [rating, count] = await this.botNFT.getBotRating(tokenId)
    return {
      rating: Number(rating) / 100, // Convert from stored format
      count: Number(count)
    }
  }

  /**
   * Upload metadata to IPFS or centralized storage
   */
  private async uploadMetadata(metadata: object): Promise<string> {
    // In production, upload to IPFS via Pinata/Web3.Storage
    // For now, return ClawNet API URL
    const metadataJson = JSON.stringify(metadata)
    // TODO: Implement actual upload
    return `https://clawnet.ai/api/metadata/${Date.now()}`
  }

  /**
   * Listen to blockchain events
   */
  async subscribeToEvents(callback: (event: any) => void): Promise<void> {
    // Subscribe to bot minted events
    this.botNFT.on('BotMinted', (tokenId, creator, name, agentType, event) => {
      callback({
        type: 'BotMinted',
        tokenId: tokenId.toString(),
        creator,
        name,
        agentType,
        event
      })
    })

    // Subscribe to bot sold events
    this.marketplace.on('BotSold', (tokenId, seller, buyer, price, event) => {
      callback({
        type: 'BotSold',
        tokenId: tokenId.toString(),
        seller,
        buyer,
        price: ethers.formatEther(price),
        event
      })
    })

    // Subscribe to bot rented events
    this.marketplace.on('BotRented', (tokenId, renter, days, totalPrice, event) => {
      callback({
        type: 'BotRented',
        tokenId: tokenId.toString(),
        renter,
        days: Number(days),
        totalPrice: ethers.formatEther(totalPrice),
        event
      })
    })
  }
}

/**
 * Get Ethereum service instance
 */
export function getEthereumService(payload: Payload): EthereumService {
  return new EthereumService(payload)
}

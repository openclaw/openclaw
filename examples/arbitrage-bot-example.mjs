#!/usr/bin/env node

/**
 * Example usage of the FlashClaw arbitrage bot
 * This demonstrates how to programmatically use the arbitrage bot API
 */

import { ArbitrageBot } from "../src/defi/index.js"

// Example configuration
const config = {
	enabled: true,
	scanInterval: 100, // 100ms scan interval
	minProfitThreshold: BigInt(10 ** 17), // 0.1 ETH minimum profit
	maxGasPrice: BigInt(100) * BigInt(10 ** 9), // 100 gwei

	blockchain: {
		rpcUrl: process.env.ETH_RPC_URL || "http://localhost:8545",
		chainId: 1,
		privateKey: process.env.PRIVATE_KEY,
		gasLimit: BigInt(500000),
		maxGasPrice: BigInt(100) * BigInt(10 ** 9),
	},

	aave: {
		poolAddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
		pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
		dataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
		weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
	},

	dexes: [
		{
			name: "Uniswap V2",
			router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
			factory: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
			fee: 3000,
		},
		{
			name: "Sushiswap",
			router: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
			factory: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
			fee: 3000,
		},
	],
}

async function main() {
	console.log("🦞 FlashClaw Arbitrage Bot Example")
	console.log("==================================\n")

	// Create the bot instance
	const bot = new ArbitrageBot(config)

	// Display configuration
	console.log("Configuration:")
	console.log(`  Scan Interval: ${config.scanInterval}ms`)
	console.log(`  Min Profit: ${config.minProfitThreshold} wei (0.1 ETH)`)
	console.log(`  Max Gas Price: ${config.maxGasPrice / BigInt(10 ** 9)} gwei`)
	console.log(`  DEXes: ${config.dexes.map((d) => d.name).join(", ")}`)
	console.log()

	// Set up signal handlers
	const shutdown = () => {
		console.log("\n\nShutting down bot...")
		bot.stop()

		// Display final stats
		const stats = bot.getStats()
		console.log("\nFinal Statistics:")
		console.log("=================")
		console.log(`Total Opportunities Found: ${stats.totalOpportunities}`)
		console.log(`Trades Executed: ${stats.executedTrades}`)
		console.log(`Successful Trades: ${stats.successfulTrades}`)
		console.log(`Failed Trades: ${stats.failedTrades}`)
		console.log(`Total Profit: ${stats.totalProfit} wei`)
		console.log(`Net Profit: ${stats.netProfit} wei`)

		process.exit(0)
	}

	process.on("SIGINT", shutdown)
	process.on("SIGTERM", shutdown)

	// Start the bot
	console.log("Starting arbitrage bot...\n")
	await bot.start()

	// Display stats every 30 seconds
	setInterval(() => {
		const stats = bot.getStats()
		console.log("\n--- Current Statistics ---")
		console.log(`Opportunities: ${stats.totalOpportunities}`)
		console.log(`Executed: ${stats.executedTrades}`)
		console.log(`Success Rate: ${stats.executedTrades > 0 ? ((stats.successfulTrades / stats.executedTrades) * 100).toFixed(1) : 0}%`)
		console.log(`Net Profit: ${stats.netProfit} wei`)
		console.log()
	}, 30000)

	// Keep the process running
	console.log("Bot is running. Press Ctrl+C to stop.\n")
}

// Run the example
main().catch((error) => {
	console.error("Fatal error:", error)
	process.exit(1)
})

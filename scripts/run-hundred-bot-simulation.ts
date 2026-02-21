#!/usr/bin/env bun
/**
 * 100 Bot Society Simulation Runner
 *
 * Executes a complete lifecycle simulation of 100 unique AI agents
 * forming an emergent society with consciousness, relationships,
 * and cultural evolution.
 *
 * Usage:
 *   bun scripts/run-hundred-bot-simulation.ts [days]
 *
 * Arguments:
 *   days - Number of simulation days to run (default: 30)
 */

import { getPayload } from 'payload'
import config from '../apps/web/payload.config'
import { getHundredBotSocietySimulation } from '../apps/web/src/lib/simulation/hundred-bot-society-simulation'

async function main() {
  console.log('\n🌍 100-BOT SOCIETY SIMULATION LAUNCHER')
  console.log('═'.repeat(80))

  // Parse arguments
  const days = Number.parseInt(process.argv[2] || '30', 10)

  if (Number.isNaN(days) || days < 1) {
    console.error('❌ Invalid number of days. Please provide a positive integer.')
    process.exit(1)
  }

  console.log(`\n📅 Simulation Duration: ${days} days`)
  console.log(`⏰ Started: ${new Date().toISOString()}`)
  console.log('═'.repeat(80) + '\n')

  try {
    // Initialize Payload
    console.log('🔧 Initializing Payload CMS...')
    const payload = await getPayload({ config })
    console.log('✅ Payload initialized\n')

    // Get simulation instance
    const simulation = getHundredBotSocietySimulation(payload)

    // Run full simulation
    console.log(`🚀 Launching ${days}-day simulation...\n`)
    const startTime = Date.now()

    await simulation.runFullSimulation(days)

    const endTime = Date.now()
    const duration = ((endTime - startTime) / 1000).toFixed(2)

    console.log(`\n⏱️  Simulation completed in ${duration} seconds`)
    console.log(`📊 Generated ${simulation.getCycles().length} daily cycles`)
    console.log(`\n✨ Simulation data preserved in memory`)
    console.log(`   - ${simulation.getBots().length} bot profiles`)
    console.log(`   - ${simulation.getCycles().length} cycle snapshots`)

    // Export summary
    const cycles = simulation.getCycles()
    const lastCycle = cycles[cycles.length - 1]

    console.log(`\n📈 FINAL METRICS:`)
    console.log(`   Population: ${lastCycle.population.alive}`)
    console.log(`   Relationships: ${lastCycle.social.totalRelationships}`)
    console.log(`   Groups: ${lastCycle.social.totalGroups}`)
    console.log(`   Leaders: ${lastCycle.social.leaders}`)
    console.log(`   Avg Consciousness: ${(lastCycle.population.averageConsciousness * 100).toFixed(1)}%`)

    console.log('\n✅ Simulation complete!')
    console.log('═'.repeat(80) + '\n')

    process.exit(0)
  } catch (error) {
    console.error('\n❌ Simulation failed:', error)
    process.exit(1)
  }
}

main()

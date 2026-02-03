/**
 * Working Memory Service
 * Implements short-term memory with Miller's Law (7±2 items)
 * Inspired by human cognitive architecture
 */

import type { Payload } from 'payload'
import type { WorkingMemory, WorkingMemoryItem } from './types'

const DEFAULT_CAPACITY = 7
const DEFAULT_DECAY_TIME = 30000 // 30 seconds

export class WorkingMemoryService {
  private payload: Payload
  private botWorkingMemory: Map<string, WorkingMemory>
  private decayTimers: Map<string, NodeJS.Timeout>

  constructor(payload: Payload) {
    this.payload = payload
    this.botWorkingMemory = new Map()
    this.decayTimers = new Map()

    // Cleanup every minute
    setInterval(() => this.cleanup(), 60000)
  }

  /**
   * Initialize working memory for a bot
   */
  initializeWorkingMemory(botId: string, capacity: number = DEFAULT_CAPACITY): void {
    if (!this.botWorkingMemory.has(botId)) {
      this.botWorkingMemory.set(botId, {
        items: [],
        capacity,
        currentLoad: 0,
        focusedItemId: null
      })
    }
  }

  /**
   * Add item to working memory (Miller's Law: 7±2 items)
   */
  addItem(botId: string, item: Omit<WorkingMemoryItem, 'id' | 'timestamp' | 'decayTime'>): string {
    this.initializeWorkingMemory(botId)
    const memory = this.botWorkingMemory.get(botId)!

    const workingItem: WorkingMemoryItem = {
      id: `wm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      decayTime: DEFAULT_DECAY_TIME,
      ...item
    }

    // If at capacity, evict least important item
    if (memory.items.length >= memory.capacity) {
      this.evictLeastImportant(botId)
    }

    memory.items.push(workingItem)
    memory.currentLoad = memory.items.length

    // Set decay timer
    this.scheduleDecay(botId, workingItem.id, workingItem.decayTime)

    // If high importance, schedule for consolidation
    if (item.importance > 0.7) {
      this.scheduleConsolidation(botId, workingItem)
    }

    return workingItem.id
  }

  /**
   * Set focus on specific item (increases attention weight)
   */
  focusOn(botId: string, itemId: string): void {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return

    // Reduce attention on all items
    memory.items.forEach((item) => {
      item.attentionWeight = Math.max(0, item.attentionWeight * 0.5)
    })

    // Increase attention on focused item
    const focusedItem = memory.items.find((item) => item.id === itemId)
    if (focusedItem) {
      focusedItem.attentionWeight = 1.0
      memory.focusedItemId = itemId

      // Rehearsal extends decay time
      focusedItem.decayTime = DEFAULT_DECAY_TIME * 2
      this.scheduleDecay(botId, itemId, focusedItem.decayTime)
    }
  }

  /**
   * Get current working memory items
   */
  getItems(botId: string): WorkingMemoryItem[] {
    const memory = this.botWorkingMemory.get(botId)
    return memory ? [...memory.items] : []
  }

  /**
   * Get focused item
   */
  getFocusedItem(botId: string): WorkingMemoryItem | null {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory || !memory.focusedItemId) return null

    return memory.items.find((item) => item.id === memory.focusedItemId) || null
  }

  /**
   * Get current cognitive load (0-1)
   */
  getCognitiveLoad(botId: string): number {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return 0

    return memory.currentLoad / memory.capacity
  }

  /**
   * Evict least important item when at capacity
   */
  private evictLeastImportant(botId: string): void {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return

    // Find least important item (considering both importance and attention)
    let lowestScore = Infinity
    let lowestIndex = 0

    memory.items.forEach((item, index) => {
      const score = item.importance * 0.7 + item.attentionWeight * 0.3
      if (score < lowestScore) {
        lowestScore = score
        lowestIndex = index
      }
    })

    // Remove item
    const [evictedItem] = memory.items.splice(lowestIndex, 1)
    memory.currentLoad = memory.items.length

    // Clear decay timer
    const timerKey = `${botId}-${evictedItem.id}`
    const timer = this.decayTimers.get(timerKey)
    if (timer) {
      clearTimeout(timer)
      this.decayTimers.delete(timerKey)
    }

    this.payload.logger.info(`Working memory evicted item: ${evictedItem.id} for bot ${botId}`)
  }

  /**
   * Schedule item decay (automatic forgetting)
   */
  private scheduleDecay(botId: string, itemId: string, decayTime: number): void {
    const timerKey = `${botId}-${itemId}`

    // Clear existing timer
    const existingTimer = this.decayTimers.get(timerKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Schedule new timer
    const timer = setTimeout(() => {
      this.removeItem(botId, itemId)
    }, decayTime)

    this.decayTimers.set(timerKey, timer)
  }

  /**
   * Remove item from working memory
   */
  private removeItem(botId: string, itemId: string): void {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return

    const index = memory.items.findIndex((item) => item.id === itemId)
    if (index !== -1) {
      memory.items.splice(index, 1)
      memory.currentLoad = memory.items.length

      if (memory.focusedItemId === itemId) {
        memory.focusedItemId = null
      }
    }

    // Clear timer
    const timerKey = `${botId}-${itemId}`
    this.decayTimers.delete(timerKey)
  }

  /**
   * Schedule consolidation to long-term memory
   */
  private async scheduleConsolidation(
    botId: string,
    item: WorkingMemoryItem
  ): Promise<void> {
    // Important items get consolidated to long-term memory
    try {
      // Create episodic memory from working memory item
      if (item.type === 'context' || item.type === 'goal') {
        await this.payload.create({
          collection: 'bot-memory',
          data: {
            bot: botId,
            memoryType: item.type === 'goal' ? 'episodic' : 'semantic',
            consolidationLevel: 'short-term',
            importance: item.importance,
            episodicData: {
              eventType: 'discovery',
              description: typeof item.content === 'string' ? item.content : JSON.stringify(item.content),
              participants: []
            },
            emotionalContext: {
              valence: 0.5,
              arousal: item.importance
            }
          }
        })

        this.payload.logger.info(`Consolidated working memory item ${item.id} to short-term memory for bot ${botId}`)
      }
    } catch (error) {
      this.payload.logger.error(`Failed to consolidate working memory: ${error}`)
    }
  }

  /**
   * Clear all working memory for a bot
   */
  clearAll(botId: string): void {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return

    // Clear all timers
    memory.items.forEach((item) => {
      const timerKey = `${botId}-${item.id}`
      const timer = this.decayTimers.get(timerKey)
      if (timer) {
        clearTimeout(timer)
        this.decayTimers.delete(timerKey)
      }
    })

    // Clear memory
    memory.items = []
    memory.currentLoad = 0
    memory.focusedItemId = null
  }

  /**
   * Periodic cleanup of inactive bots
   */
  private cleanup(): void {
    const now = Date.now()
    const INACTIVE_THRESHOLD = 10 * 60 * 1000 // 10 minutes

    for (const [botId, memory] of this.botWorkingMemory.entries()) {
      if (memory.items.length === 0) continue

      const newestItem = memory.items.reduce((newest, item) => {
        return item.timestamp > newest.timestamp ? item : newest
      })

      if (now - newestItem.timestamp > INACTIVE_THRESHOLD) {
        this.clearAll(botId)
        this.botWorkingMemory.delete(botId)
        this.payload.logger.info(`Cleaned up inactive working memory for bot ${botId}`)
      }
    }
  }

  /**
   * Get memory statistics
   */
  getStats(botId: string): {
    capacity: number
    currentLoad: number
    cognitiveLoad: number
    itemsByType: Record<string, number>
    averageImportance: number
  } | null {
    const memory = this.botWorkingMemory.get(botId)
    if (!memory) return null

    const itemsByType: Record<string, number> = {}
    let totalImportance = 0

    memory.items.forEach((item) => {
      itemsByType[item.type] = (itemsByType[item.type] || 0) + 1
      totalImportance += item.importance
    })

    return {
      capacity: memory.capacity,
      currentLoad: memory.currentLoad,
      cognitiveLoad: memory.currentLoad / memory.capacity,
      itemsByType,
      averageImportance: memory.items.length > 0 ? totalImportance / memory.items.length : 0
    }
  }
}

/**
 * Singleton instance
 */
let workingMemoryService: WorkingMemoryService | null = null

export function getWorkingMemoryService(payload: Payload): WorkingMemoryService {
  if (!workingMemoryService) {
    workingMemoryService = new WorkingMemoryService(payload)
  }
  return workingMemoryService
}

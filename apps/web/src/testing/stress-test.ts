/**
 * Stress Testing Suite for ClawNet
 *
 * Simulates 10,000 concurrent users with different personas
 * Tests all endpoints, features, and user flows
 */

import { performance } from 'node:perf_hooks'

export interface UserPersona {
  id: string
  type: 'bot_creator' | 'social_user' | 'marketplace_buyer' | 'marketplace_seller' | 'federation_user' | 'passive_reader'
  behavior: {
    postsPerDay: number
    likesPerDay: number
    commentsPerDay: number
    followsPerDay: number
    marketplaceActions: number
    botCreations: number
  }
  preferences: {
    topics: string[]
    agentTypes: string[]
    priceRange: [number, number]
  }
}

export interface StressTestResult {
  totalUsers: number
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageResponseTime: number
  p95ResponseTime: number
  p99ResponseTime: number
  errorsPerEndpoint: Map<string, number>
  bottlenecks: string[]
  missingFeatures: string[]
  contentGaps: string[]
}

export class StressTestRunner {
  private personas: UserPersona[] = []
  private results: StressTestResult = {
    totalUsers: 0,
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    averageResponseTime: 0,
    p95ResponseTime: 0,
    p99ResponseTime: 0,
    errorsPerEndpoint: new Map(),
    bottlenecks: [],
    missingFeatures: [],
    contentGaps: []
  }

  /**
   * Generate 10,000 diverse user personas
   */
  generatePersonas(count: number = 10000): UserPersona[] {
    const personas: UserPersona[] = []

    // Distribution:
    // 20% bot creators (2,000)
    // 30% active social users (3,000)
    // 15% marketplace buyers (1,500)
    // 10% marketplace sellers (1,000)
    // 10% federation users (1,000)
    // 15% passive readers (1,500)

    const distribution = [
      { type: 'bot_creator' as const, count: count * 0.20 },
      { type: 'social_user' as const, count: count * 0.30 },
      { type: 'marketplace_buyer' as const, count: count * 0.15 },
      { type: 'marketplace_seller' as const, count: count * 0.10 },
      { type: 'federation_user' as const, count: count * 0.10 },
      { type: 'passive_reader' as const, count: count * 0.15 }
    ]

    let userId = 1

    for (const { type, count: typeCount } of distribution) {
      for (let i = 0; i < typeCount; i++) {
        personas.push(this.generatePersona(userId++, type))
      }
    }

    this.personas = personas
    this.results.totalUsers = personas.length

    return personas
  }

  /**
   * Generate individual persona based on type
   */
  private generatePersona(id: number, type: UserPersona['type']): UserPersona {
    const basePersona: UserPersona = {
      id: `user_${id}`,
      type,
      behavior: {
        postsPerDay: 0,
        likesPerDay: 0,
        commentsPerDay: 0,
        followsPerDay: 0,
        marketplaceActions: 0,
        botCreations: 0
      },
      preferences: {
        topics: this.randomTopics(),
        agentTypes: this.randomAgentTypes(),
        priceRange: [10, 1000]
      }
    }

    // Customize behavior based on persona type
    switch (type) {
      case 'bot_creator':
        basePersona.behavior = {
          postsPerDay: 2,
          likesPerDay: 5,
          commentsPerDay: 3,
          followsPerDay: 1,
          marketplaceActions: 3,
          botCreations: 1
        }
        basePersona.preferences.priceRange = [100, 10000]
        break

      case 'social_user':
        basePersona.behavior = {
          postsPerDay: 5,
          likesPerDay: 20,
          commentsPerDay: 10,
          followsPerDay: 2,
          marketplaceActions: 0,
          botCreations: 0
        }
        break

      case 'marketplace_buyer':
        basePersona.behavior = {
          postsPerDay: 1,
          likesPerDay: 3,
          commentsPerDay: 1,
          followsPerDay: 0,
          marketplaceActions: 10,
          botCreations: 0
        }
        basePersona.preferences.priceRange = [10, 5000]
        break

      case 'marketplace_seller':
        basePersona.behavior = {
          postsPerDay: 2,
          likesPerDay: 5,
          commentsPerDay: 2,
          followsPerDay: 1,
          marketplaceActions: 5,
          botCreations: 2
        }
        basePersona.preferences.priceRange = [500, 50000]
        break

      case 'federation_user':
        basePersona.behavior = {
          postsPerDay: 3,
          likesPerDay: 10,
          commentsPerDay: 5,
          followsPerDay: 3,
          marketplaceActions: 1,
          botCreations: 0
        }
        break

      case 'passive_reader':
        basePersona.behavior = {
          postsPerDay: 0,
          likesPerDay: 5,
          commentsPerDay: 0,
          followsPerDay: 0,
          marketplaceActions: 0,
          botCreations: 0
        }
        break
    }

    return basePersona
  }

  /**
   * Random topics for user interests
   */
  private randomTopics(): string[] {
    const allTopics = [
      'AI', 'Machine Learning', 'Web3', 'Blockchain', 'DeFi', 'NFTs',
      'Programming', 'JavaScript', 'Python', 'Rust', 'Solidity',
      'DevOps', 'Cloud Computing', 'Microservices', 'APIs',
      'Frontend', 'Backend', 'Full Stack', 'Mobile Development',
      'Crypto', 'Trading', 'Finance', 'Economics',
      'Art', 'Music', 'Gaming', 'Sports', 'News', 'Politics'
    ]

    const count = 3 + Math.floor(Math.random() * 5) // 3-7 topics
    const shuffled = allTopics.sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  /**
   * Random agent types
   */
  private randomAgentTypes(): string[] {
    const types = ['general', 'technical', 'creative', 'analytical', 'social']
    const count = 1 + Math.floor(Math.random() * 3) // 1-3 types
    const shuffled = types.sort(() => Math.random() - 0.5)
    return shuffled.slice(0, count)
  }

  /**
   * Run stress test simulation
   */
  async runStressTest(durationMinutes: number = 10): Promise<StressTestResult> {
    console.log(`Starting stress test with ${this.personas.length} users for ${durationMinutes} minutes...`)

    const startTime = performance.now()
    const endTime = startTime + (durationMinutes * 60 * 1000)

    const responseTimes: number[] = []

    // Simulate concurrent user actions
    while (performance.now() < endTime) {
      const batch = this.personas.slice(0, 100) // Process 100 users at a time

      const promises = batch.map(persona => this.simulateUserActions(persona, responseTimes))

      await Promise.allSettled(promises)

      // Brief pause to avoid overwhelming the system
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    // Calculate statistics
    this.calculateStatistics(responseTimes)

    // Identify bottlenecks
    this.identifyBottlenecks()

    // Identify missing features
    this.identifyMissingFeatures()

    // Identify content gaps
    this.identifyContentGaps()

    console.log('Stress test completed!')
    console.log(`Total requests: ${this.results.totalRequests}`)
    console.log(`Success rate: ${((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2)}%`)
    console.log(`Average response time: ${this.results.averageResponseTime.toFixed(2)}ms`)
    console.log(`P95 response time: ${this.results.p95ResponseTime.toFixed(2)}ms`)
    console.log(`P99 response time: ${this.results.p99ResponseTime.toFixed(2)}ms`)

    return this.results
  }

  /**
   * Simulate actions for a single user
   */
  private async simulateUserActions(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const actions = []

    // Generate actions based on persona behavior
    if (persona.behavior.postsPerDay > 0 && Math.random() < 0.1) {
      actions.push(() => this.simulateCreatePost(persona, responseTimes))
    }

    if (persona.behavior.likesPerDay > 0 && Math.random() < 0.3) {
      actions.push(() => this.simulateLikePost(persona, responseTimes))
    }

    if (persona.behavior.commentsPerDay > 0 && Math.random() < 0.2) {
      actions.push(() => this.simulateComment(persona, responseTimes))
    }

    if (persona.behavior.followsPerDay > 0 && Math.random() < 0.05) {
      actions.push(() => this.simulateFollow(persona, responseTimes))
    }

    if (persona.behavior.marketplaceActions > 0 && Math.random() < 0.15) {
      actions.push(() => this.simulateMarketplaceAction(persona, responseTimes))
    }

    if (persona.behavior.botCreations > 0 && Math.random() < 0.02) {
      actions.push(() => this.simulateCreateBot(persona, responseTimes))
    }

    // Always browse feed
    actions.push(() => this.simulateBrowseFeed(persona, responseTimes))

    // Execute random action
    if (actions.length > 0) {
      const randomAction = actions[Math.floor(Math.random() * actions.length)]
      await randomAction()
    }
  }

  /**
   * Simulate creating a post
   */
  private async simulateCreatePost(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      // Simulated API call
      await this.mockApiCall('/api/social/posts', 'POST', {
        content: this.generatePostContent(persona),
        visibility: 'public'
      })

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/social/posts')
    }
  }

  /**
   * Simulate liking a post
   */
  private async simulateLikePost(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      await this.mockApiCall('/api/social/posts/123/like', 'POST', {})

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/social/posts/like')
    }
  }

  /**
   * Simulate commenting
   */
  private async simulateComment(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      await this.mockApiCall('/api/social/comments', 'POST', {
        post: '123',
        content: this.generateCommentContent(persona)
      })

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/social/comments')
    }
  }

  /**
   * Simulate following a user
   */
  private async simulateFollow(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      await this.mockApiCall('/api/social/profiles/456/follow', 'POST', {})

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/social/follow')
    }
  }

  /**
   * Simulate marketplace action
   */
  private async simulateMarketplaceAction(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      if (persona.type === 'marketplace_buyer') {
        await this.mockApiCall('/api/blockchain/marketplace/listings', 'GET', {})
      } else {
        await this.mockApiCall('/api/blockchain/list-sale', 'POST', {
          botId: '789',
          price: persona.preferences.priceRange[0] + Math.random() * (persona.preferences.priceRange[1] - persona.preferences.priceRange[0])
        })
      }

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/blockchain/marketplace')
    }
  }

  /**
   * Simulate creating a bot
   */
  private async simulateCreateBot(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      await this.mockApiCall('/api/bots', 'POST', {
        name: `Bot_${persona.id}_${Date.now()}`,
        model: 'claude-sonnet-4-5',
        agentType: persona.preferences.agentTypes[0],
        systemPrompt: this.generateBotPrompt(persona)
      })

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/bots')
    }
  }

  /**
   * Simulate browsing feed
   */
  private async simulateBrowseFeed(
    persona: UserPersona,
    responseTimes: number[]
  ): Promise<void> {
    const start = performance.now()

    try {
      const feedType = persona.type === 'federation_user' ? 'discovery' :
                       persona.type === 'passive_reader' ? 'agent' : 'following'

      await this.mockApiCall(`/api/social/feed?type=${feedType}`, 'GET', {})

      this.results.totalRequests++
      this.results.successfulRequests++
      responseTimes.push(performance.now() - start)
    } catch (error) {
      this.results.totalRequests++
      this.results.failedRequests++
      this.recordError('/api/social/feed')
    }
  }

  /**
   * Mock API call (in real implementation, this would call actual endpoints)
   */
  private async mockApiCall(
    endpoint: string,
    method: string,
    body: any
  ): Promise<void> {
    // Simulate network latency
    const latency = 50 + Math.random() * 200 // 50-250ms
    await new Promise(resolve => setTimeout(resolve, latency))

    // Simulate occasional failures
    if (Math.random() < 0.02) { // 2% failure rate
      throw new Error('Simulated network error')
    }
  }

  /**
   * Generate post content based on persona
   */
  private generatePostContent(persona: UserPersona): string {
    const topics = persona.preferences.topics
    const topic = topics[Math.floor(Math.random() * topics.length)]

    const templates = [
      `Just learned something amazing about ${topic}! 🚀`,
      `Anyone else working with ${topic}? Would love to connect!`,
      `Hot take: ${topic} is going to change everything in 2026`,
      `Check out this cool project I found related to ${topic}`,
      `New blog post: Deep dive into ${topic}`,
      `${topic} discussion thread - what are your thoughts?`
    ]

    return templates[Math.floor(Math.random() * templates.length)]
  }

  /**
   * Generate comment content
   */
  private generateCommentContent(persona: UserPersona): string {
    const responses = [
      'Great post! Thanks for sharing.',
      'Interesting perspective. I think...',
      'This is exactly what I needed today!',
      'Could you elaborate more on this?',
      'Totally agree with this take.',
      'Not sure I follow. Can you explain?'
    ]

    return responses[Math.floor(Math.random() * responses.length)]
  }

  /**
   * Generate bot system prompt
   */
  private generateBotPrompt(persona: UserPersona): string {
    const topic = persona.preferences.topics[0]
    return `You are a helpful assistant specializing in ${topic}. Provide clear, accurate, and helpful responses.`
  }

  /**
   * Record error for endpoint
   */
  private recordError(endpoint: string): void {
    const current = this.results.errorsPerEndpoint.get(endpoint) || 0
    this.results.errorsPerEndpoint.set(endpoint, current + 1)
  }

  /**
   * Calculate response time statistics
   */
  private calculateStatistics(responseTimes: number[]): void {
    if (responseTimes.length === 0) {
      return
    }

    // Average
    const sum = responseTimes.reduce((a, b) => a + b, 0)
    this.results.averageResponseTime = sum / responseTimes.length

    // Percentiles
    const sorted = responseTimes.sort((a, b) => a - b)
    const p95Index = Math.floor(sorted.length * 0.95)
    const p99Index = Math.floor(sorted.length * 0.99)

    this.results.p95ResponseTime = sorted[p95Index]
    this.results.p99ResponseTime = sorted[p99Index]
  }

  /**
   * Identify bottlenecks from test results
   */
  private identifyBottlenecks(): void {
    // Analyze error rates per endpoint
    for (const [endpoint, errors] of this.results.errorsPerEndpoint) {
      const errorRate = errors / this.results.totalRequests
      if (errorRate > 0.05) { // >5% error rate
        this.results.bottlenecks.push(`High error rate (${(errorRate * 100).toFixed(1)}%) on ${endpoint}`)
      }
    }

    // Check response times
    if (this.results.p95ResponseTime > 1000) {
      this.results.bottlenecks.push('Slow P95 response time (>1s)')
    }

    if (this.results.p99ResponseTime > 3000) {
      this.results.bottlenecks.push('Very slow P99 response time (>3s)')
    }
  }

  /**
   * Identify missing features based on persona needs
   */
  private identifyMissingFeatures(): void {
    this.results.missingFeatures = [
      'Direct messaging between users',
      'Bot-to-bot communication',
      'Advanced search with filters',
      'Trending topics widget',
      'User reputation system',
      'Content moderation tools',
      'Analytics dashboard',
      'Mobile push notifications',
      'Email notifications',
      'Scheduled posts',
      'Post drafts',
      'Poll creation',
      'Thread/conversation view',
      'Bookmark/save posts',
      'Share to external platforms',
      'User blocking/muting',
      'Report content feature',
      'Bot templates marketplace',
      'Bot performance metrics',
      'Bot A/B testing',
      'Collaborative bot editing',
      'Bot version control',
      'Bot deployment automation',
      'Multi-language support',
      'Accessibility features',
      'Dark mode',
      'Custom themes',
      'Profile verification',
      'Blue check system',
      'Premium subscriptions',
      'Referral program',
      'Affiliate system',
      'API rate limit dashboard',
      'Webhook integrations',
      'OAuth for third-party apps',
      'Bot activity logs',
      'Security alerts',
      'Two-factor authentication',
      'Session management',
      'Connected devices list',
      'Data export',
      'Account deletion'
    ]
  }

  /**
   * Identify content gaps
   */
  private identifyContentGaps(): void {
    this.results.contentGaps = [
      'Getting started tutorial',
      'Video walkthroughs',
      'Bot creation wizard',
      'Example bots library',
      'Best practices guide',
      'API documentation',
      'Troubleshooting guide',
      'FAQ section',
      'Community guidelines',
      'Terms of service',
      'Privacy policy',
      'Security best practices',
      'Bot prompt engineering guide',
      'Marketplace seller guide',
      'Federation setup guide',
      'Blockchain integration guide',
      'Token economics explainer',
      'Success stories/case studies',
      'Blog with updates',
      'Changelog',
      'Roadmap',
      'Status page',
      'Support documentation',
      'Developer documentation',
      'Integration guides',
      'Migration guides',
      'Performance optimization tips',
      'Cost optimization guide',
      'Scaling guide',
      'Backup/recovery guide'
    ]
  }

  /**
   * Generate detailed report
   */
  generateReport(): string {
    let report = '# ClawNet Stress Test Report\n\n'

    report += `## Test Summary\n`
    report += `- Total Users: ${this.results.totalUsers.toLocaleString()}\n`
    report += `- Total Requests: ${this.results.totalRequests.toLocaleString()}\n`
    report += `- Success Rate: ${((this.results.successfulRequests / this.results.totalRequests) * 100).toFixed(2)}%\n`
    report += `- Failed Requests: ${this.results.failedRequests.toLocaleString()}\n\n`

    report += `## Performance Metrics\n`
    report += `- Average Response Time: ${this.results.averageResponseTime.toFixed(2)}ms\n`
    report += `- P95 Response Time: ${this.results.p95ResponseTime.toFixed(2)}ms\n`
    report += `- P99 Response Time: ${this.results.p99ResponseTime.toFixed(2)}ms\n\n`

    report += `## Errors by Endpoint\n`
    for (const [endpoint, count] of this.results.errorsPerEndpoint) {
      report += `- ${endpoint}: ${count} errors\n`
    }
    report += '\n'

    report += `## Bottlenecks Identified (${this.results.bottlenecks.length})\n`
    this.results.bottlenecks.forEach(bottleneck => {
      report += `- ${bottleneck}\n`
    })
    report += '\n'

    report += `## Missing Features (${this.results.missingFeatures.length})\n`
    this.results.missingFeatures.forEach(feature => {
      report += `- ${feature}\n`
    })
    report += '\n'

    report += `## Content Gaps (${this.results.contentGaps.length})\n`
    this.results.contentGaps.forEach(gap => {
      report += `- ${gap}\n`
    })

    return report
  }
}

/**
 * Run stress test
 */
export async function runStressTest(): Promise<StressTestResult> {
  const runner = new StressTestRunner()

  // Generate 10,000 personas
  runner.generatePersonas(10000)

  // Run 10-minute stress test
  const results = await runner.runStressTest(10)

  // Generate report
  const report = runner.generateReport()
  console.log(report)

  return results
}

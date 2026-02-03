import { describe, it, expect, beforeEach, vi } from 'vitest'
import { authorizeBotOwnership, createRateLimiter } from '../authorize'

describe('authorizeBotOwnership middleware', () => {
  let mockReq: any
  let mockRes: any
  let mockNext: any

  beforeEach(() => {
    mockReq = {
      user: { id: 'user123' },
      body: {},
      query: {},
      params: {},
      payload: {
        findByID: vi.fn()
      }
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }

    mockNext = vi.fn()
  })

  it('should call next() when user owns the bot', async () => {
    mockReq.body.botId = 'bot123'

    const mockBot = {
      id: 'bot123',
      name: 'Test Bot',
      user: 'user123' // Owned by the authenticated user
    }

    mockReq.payload.findByID.mockResolvedValue(mockBot)

    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockReq.payload.findByID).toHaveBeenCalledWith({
      collection: 'bots',
      id: 'bot123'
    })
    expect(mockNext).toHaveBeenCalled()
    expect(mockReq.bot).toEqual(mockBot)
  })

  it('should return 400 when botId is missing', async () => {
    // No botId provided
    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(400)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Bot ID required'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should return 403 when user does not own the bot', async () => {
    mockReq.body.botId = 'bot123'

    const mockBot = {
      id: 'bot123',
      name: 'Test Bot',
      user: 'differentUser456' // Owned by different user
    }

    mockReq.payload.findByID.mockResolvedValue(mockBot)

    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'You do not own this bot'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should handle bot user as object reference', async () => {
    mockReq.body.botId = 'bot123'

    const mockBot = {
      id: 'bot123',
      name: 'Test Bot',
      user: { id: 'user123', email: 'user@example.com' } // User as object
    }

    mockReq.payload.findByID.mockResolvedValue(mockBot)

    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
  })

  it('should get botId from query params', async () => {
    mockReq.query.botId = 'bot123'

    const mockBot = {
      id: 'bot123',
      user: 'user123'
    }

    mockReq.payload.findByID.mockResolvedValue(mockBot)

    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
  })

  it('should get botId from URL params', async () => {
    mockReq.params.botId = 'bot123'

    const mockBot = {
      id: 'bot123',
      user: 'user123'
    }

    mockReq.payload.findByID.mockResolvedValue(mockBot)

    await authorizeBotOwnership(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
  })
})

describe('createRateLimiter', () => {
  let mockReq: any
  let mockRes: any
  let mockNext: any

  beforeEach(() => {
    mockReq = {
      user: { id: 'user123' },
      ip: '127.0.0.1'
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }

    mockNext = vi.fn()

    // Reset Date.now for consistent testing
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should allow requests under the rate limit', () => {
    const rateLimiter = createRateLimiter({
      windowMs: 60000, // 1 minute
      max: 5
    })

    // Make 5 requests (under limit)
    for (let i = 0; i < 5; i++) {
      rateLimiter(mockReq, mockRes, mockNext)
    }

    expect(mockNext).toHaveBeenCalledTimes(5)
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should block requests over the rate limit', () => {
    const rateLimiter = createRateLimiter({
      windowMs: 60000, // 1 minute
      max: 3
    })

    // Make 3 allowed requests
    for (let i = 0; i < 3; i++) {
      rateLimiter(mockReq, mockRes, mockNext)
    }

    // 4th request should be blocked
    rateLimiter(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalledTimes(3)
    expect(mockRes.status).toHaveBeenCalledWith(429)
    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'Too many requests',
        retryAfter: expect.any(Number)
      })
    )
  })

  it('should reset after time window expires', () => {
    const rateLimiter = createRateLimiter({
      windowMs: 60000, // 1 minute
      max: 2
    })

    // Make 2 requests
    rateLimiter(mockReq, mockRes, mockNext)
    rateLimiter(mockReq, mockRes, mockNext)

    // Advance time past window
    vi.advanceTimersByTime(61000) // 61 seconds

    // Should allow new requests
    rateLimiter(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalledTimes(3)
  })

  it('should track requests per user', () => {
    const rateLimiter = createRateLimiter({
      windowMs: 60000,
      max: 2
    })

    const user1Req = { ...mockReq, user: { id: 'user1' } }
    const user2Req = { ...mockReq, user: { id: 'user2' } }

    // User 1 makes 2 requests
    rateLimiter(user1Req, mockRes, mockNext)
    rateLimiter(user1Req, mockRes, mockNext)

    // User 2 should still be allowed
    rateLimiter(user2Req, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalledTimes(3)
  })

  it('should track requests by IP when no user', () => {
    const rateLimiter = createRateLimiter({
      windowMs: 60000,
      max: 2
    })

    const req1 = { ...mockReq, user: null, ip: '192.168.1.1' }
    const req2 = { ...mockReq, user: null, ip: '192.168.1.2' }

    // IP 1 makes 2 requests
    rateLimiter(req1, mockRes, mockNext)
    rateLimiter(req1, mockRes, mockNext)

    // IP 2 should still be allowed
    rateLimiter(req2, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalledTimes(3)
  })

  it('should use custom message when provided', () => {
    const customMessage = 'Custom rate limit message'
    const rateLimiter = createRateLimiter({
      windowMs: 60000,
      max: 1,
      message: customMessage
    })

    // Exceed limit
    rateLimiter(mockReq, mockRes, mockNext)
    rateLimiter(mockReq, mockRes, mockNext)

    expect(mockRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: customMessage
      })
    )
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateCsrfToken, verifyCsrfToken } from '../csrf'
import { createHash } from 'node:crypto'

describe('generateCsrfToken', () => {
  let mockReq: any
  let mockRes: any

  beforeEach(() => {
    mockReq = {
      user: { id: 'user123' },
      ip: '127.0.0.1',
      session: {}
    }

    mockRes = {
      json: vi.fn()
    }
  })

  it('should generate and return a CSRF token', async () => {
    await generateCsrfToken(mockReq, mockRes)

    expect(mockRes.json).toHaveBeenCalled()
    const response = mockRes.json.mock.calls[0][0]

    expect(response).toHaveProperty('csrfToken')
    expect(response).toHaveProperty('expiresIn', 3600)
    expect(typeof response.csrfToken).toBe('string')
    expect(response.csrfToken.length).toBeGreaterThan(0)
  })

  it('should store hashed token in session', async () => {
    await generateCsrfToken(mockReq, mockRes)

    expect(mockReq.session).toHaveProperty('csrfSecret')
    expect(mockReq.session).toHaveProperty('csrfTokens')
    expect(mockReq.session.csrfTokens).toBeInstanceOf(Set)
    expect(mockReq.session.csrfTokens.size).toBe(1)
  })

  it('should generate different tokens on each call', async () => {
    await generateCsrfToken(mockReq, mockRes)
    const token1 = mockRes.json.mock.calls[0][0].csrfToken

    mockRes.json.mockClear()

    await generateCsrfToken(mockReq, mockRes)
    const token2 = mockRes.json.mock.calls[0][0].csrfToken

    expect(token1).not.toEqual(token2)
  })

  it('should accumulate tokens in session', async () => {
    await generateCsrfToken(mockReq, mockRes)
    await generateCsrfToken(mockReq, mockRes)

    expect(mockReq.session.csrfTokens.size).toBe(2)
  })
})

describe('verifyCsrfToken', () => {
  let mockReq: any
  let mockRes: any
  let mockNext: any

  beforeEach(() => {
    mockReq = {
      method: 'POST',
      user: { id: 'user123' },
      ip: '127.0.0.1',
      headers: {},
      body: {},
      session: {}
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }

    mockNext = vi.fn()
  })

  it('should skip verification for GET requests', () => {
    mockReq.method = 'GET'

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should skip verification for HEAD requests', () => {
    mockReq.method = 'HEAD'

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should verify valid CSRF token from header', () => {
    const secret = 'test-secret'
    const token = createHash('sha256')
      .update(secret + 'user123')
      .digest('hex')

    mockReq.session.csrfSecret = secret
    mockReq.session.csrfTokens = new Set([token])
    mockReq.headers['x-csrf-token'] = token

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should verify valid CSRF token from body', () => {
    const secret = 'test-secret'
    const token = createHash('sha256')
      .update(secret + 'user123')
      .digest('hex')

    mockReq.session.csrfSecret = secret
    mockReq.session.csrfTokens = new Set([token])
    mockReq.body._csrf = token

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
  })

  it('should reject missing CSRF token', () => {
    mockReq.session.csrfSecret = 'secret'
    mockReq.session.csrfTokens = new Set()

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Invalid CSRF token'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should reject invalid CSRF token', () => {
    mockReq.session.csrfSecret = 'secret'
    mockReq.session.csrfTokens = new Set(['valid-token'])
    mockReq.headers['x-csrf-token'] = 'invalid-token'

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should reject expired CSRF token', () => {
    mockReq.session.csrfSecret = 'secret'
    mockReq.session.csrfTokens = new Set()
    mockReq.headers['x-csrf-token'] = 'expired-token'

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
  })

  it('should delete token after successful verification (one-time use)', () => {
    const secret = 'test-secret'
    const token = createHash('sha256')
      .update(secret + 'user123')
      .digest('hex')

    mockReq.session.csrfSecret = secret
    mockReq.session.csrfTokens = new Set([token])
    mockReq.headers['x-csrf-token'] = token

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockReq.session.csrfTokens.has(token)).toBe(false)
  })

  it('should handle missing session gracefully', () => {
    mockReq.session = {}
    mockReq.headers['x-csrf-token'] = 'some-token'

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
  })

  it('should use IP address when user is not present', () => {
    const secret = 'test-secret'
    const token = createHash('sha256')
      .update(secret + '127.0.0.1')
      .digest('hex')

    mockReq.user = null
    mockReq.session.csrfSecret = secret
    mockReq.session.csrfTokens = new Set([token])
    mockReq.headers['x-csrf-token'] = token

    verifyCsrfToken(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
  })
})

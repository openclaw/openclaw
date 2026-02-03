import { describe, it, expect, beforeEach, vi } from 'vitest'
import { authenticate, requireAdmin } from '../authenticate'

describe('authenticate middleware', () => {
  let mockReq: any
  let mockRes: any
  let mockNext: any

  beforeEach(() => {
    mockReq = {
      user: null
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }

    mockNext = vi.fn()
  })

  it('should call next() when user is authenticated', () => {
    mockReq.user = { id: '123', email: 'test@example.com', role: 'viewer' }

    authenticate(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should return 401 when user is not authenticated', () => {
    mockReq.user = null

    authenticate(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Authentication required',
      message: 'Please log in to access this resource'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should return 401 when user is undefined', () => {
    mockReq.user = undefined

    authenticate(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockNext).not.toHaveBeenCalled()
  })
})

describe('requireAdmin middleware', () => {
  let mockReq: any
  let mockRes: any
  let mockNext: any

  beforeEach(() => {
    mockReq = {
      user: null
    }

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn()
    }

    mockNext = vi.fn()
  })

  it('should call next() when user is admin', () => {
    mockReq.user = { id: '123', email: 'admin@example.com', role: 'admin' }

    requireAdmin(mockReq, mockRes, mockNext)

    expect(mockNext).toHaveBeenCalled()
    expect(mockRes.status).not.toHaveBeenCalled()
  })

  it('should return 401 when user is not authenticated', () => {
    mockReq.user = null

    requireAdmin(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(401)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Authentication required'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should return 403 when user is not admin', () => {
    mockReq.user = { id: '123', email: 'user@example.com', role: 'viewer' }

    requireAdmin(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockRes.json).toHaveBeenCalledWith({
      error: 'Forbidden',
      message: 'Admin access required'
    })
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should return 403 when user role is operator', () => {
    mockReq.user = { id: '123', email: 'operator@example.com', role: 'operator' }

    requireAdmin(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockNext).not.toHaveBeenCalled()
  })

  it('should return 403 when user has no role', () => {
    mockReq.user = { id: '123', email: 'user@example.com' }

    requireAdmin(mockReq, mockRes, mockNext)

    expect(mockRes.status).toHaveBeenCalledWith(403)
    expect(mockNext).not.toHaveBeenCalled()
  })
})

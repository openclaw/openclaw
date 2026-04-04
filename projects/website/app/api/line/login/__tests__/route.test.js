import { POST } from '../route';
import { createClient } from '@/utils/supabase/server';
import { createMockSupabaseClient } from '@/__mocks__/supabase-mock-helper';

// Mock Supabase
jest.mock('@/utils/supabase/server', () => ({
  createClient: jest.fn(),
}));

// Mock fetch for verify-token API
global.fetch = jest.fn();

describe('POST /api/line/login', () => {
  let mockSupabase;
  let mockRequest;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Create mock Supabase client
    mockSupabase = createMockSupabaseClient();
    createClient.mockResolvedValue(mockSupabase);

    // Setup mock request
    mockRequest = {
      json: jest.fn(),
      nextUrl: {
        origin: 'http://localhost:3000',
      },
    };
  });

  describe('驗證必要欄位', () => {
    test('應該拒絕缺少 lineUserId 的請求', async () => {
      mockRequest.json.mockResolvedValue({
        accessToken: 'valid_token',
        displayName: 'Test User',
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('lineUserId');
    });

    test('應該拒絕缺少 accessToken 的請求', async () => {
      mockRequest.json.mockResolvedValue({
        lineUserId: 'U123',
        displayName: 'Test User',
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toContain('accessToken');
    });
  });

  describe('Access Token 驗證', () => {
    test('應該拒絕無效的 Access Token', async () => {
      mockRequest.json.mockResolvedValue({
        lineUserId: 'U123',
        accessToken: 'invalid_token',
        displayName: 'Test User',
      });

      // Mock verify-token API 返回 401
      global.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(401);
      expect(data.error).toContain('Invalid LINE access token');
    });

    test('應該呼叫 verify-token API', async () => {
      mockRequest.json.mockResolvedValue({
        lineUserId: 'U123',
        accessToken: 'valid_token',
        displayName: 'Test User',
      });

      // Mock verify-token API 成功
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: true }),
      });

      // Mock 查詢 profile (不存在)
      mockSupabase._setQueryResult({
        data: null,
        error: { code: 'PGRST116' },
      });

      // Mock 建立用戶
      mockSupabase.auth.admin.createUser.mockResolvedValueOnce({
        data: {
          user: { id: 'new-user-id' },
        },
        error: null,
      });

      // Mock insert profile
      mockSupabase._setInsertResult({
        data: null,
        error: null,
      });

      await POST(mockRequest);

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:3000/api/line/verify-token',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ accessToken: 'valid_token' }),
        })
      );
    });
  });

  describe('新用戶註冊', () => {
    beforeEach(() => {
      mockRequest.json.mockResolvedValue({
        lineUserId: 'U_NEW_USER',
        accessToken: 'valid_token',
        displayName: 'New User',
        pictureUrl: 'https://example.com/pic.jpg',
      });

      // Mock verify-token 成功
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: true }),
      });

      // Mock 查詢 profile (不存在)
      mockSupabase._setQueryResult({
        data: null,
        error: { code: 'PGRST116' },
      });
    });

    test('應該建立 auth.users 和 profiles', async () => {
      mockSupabase.auth.admin.createUser.mockResolvedValueOnce({
        data: {
          user: { id: 'new-user-id' },
        },
        error: null,
      });

      mockSupabase._setInsertResult({
        data: null,
        error: null,
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.isNewUser).toBe(true);
      expect(data.userId).toBe('new-user-id');

      // 驗證 createUser 被呼叫
      expect(mockSupabase.auth.admin.createUser).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'U_NEW_USER@line.thinker.cafe',
          email_confirm: true,
          user_metadata: expect.objectContaining({
            lineUserId: 'U_NEW_USER',
            displayName: 'New User',
            pictureUrl: 'https://example.com/pic.jpg',
            authProvider: 'line',
          }),
        })
      );

      // 驗證 from('profiles').insert() 被呼叫
      expect(mockSupabase.from).toHaveBeenCalledWith('profiles');
    });

    test('如果建立 auth.users 失敗，應該返回錯誤', async () => {
      mockSupabase.auth.admin.createUser.mockResolvedValueOnce({
        data: null,
        error: { message: 'Failed to create user' },
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to create user');
    });

    test('如果建立 profile 失敗，應該刪除 auth.users', async () => {
      mockSupabase.auth.admin.createUser.mockResolvedValueOnce({
        data: {
          user: { id: 'new-user-id' },
        },
        error: null,
      });

      mockSupabase._setInsertResult({
        data: null,
        error: { message: 'Failed to create profile' },
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(500);
      expect(data.error).toContain('Failed to create profile');

      // 驗證 deleteUser 被呼叫
      expect(mockSupabase.auth.admin.deleteUser).toHaveBeenCalledWith('new-user-id');
    });
  });

  describe('現有用戶登入', () => {
    beforeEach(() => {
      mockRequest.json.mockResolvedValue({
        lineUserId: 'U_EXISTING',
        accessToken: 'valid_token',
        displayName: 'Updated Name',
        pictureUrl: 'https://example.com/new-pic.jpg',
      });

      // Mock verify-token 成功
      global.fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ valid: true }),
      });
    });

    test('應該返回現有用戶資訊', async () => {
      // Mock 查詢 profile (存在)
      mockSupabase._setQueryResult({
        data: {
          user_id: 'existing-user-id',
          line_user_id: 'U_EXISTING',
          full_name: 'Existing User',
          auth_provider: 'line',
        },
        error: null,
      });

      mockSupabase.auth.admin.generateLink.mockResolvedValueOnce({
        data: { properties: { action_link: 'magic-link' } },
        error: null,
      });

      mockSupabase._setUpdateResult({
        data: null,
        error: null,
      });

      const response = await POST(mockRequest);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.isNewUser).toBe(false);
      expect(data.userId).toBe('existing-user-id');
      expect(data.profile.fullName).toBe('Existing User');
    });

    test('應該更新 displayName 和 pictureUrl', async () => {
      mockSupabase._setQueryResult({
        data: {
          user_id: 'existing-user-id',
          line_user_id: 'U_EXISTING',
          full_name: 'Existing User',
          auth_provider: 'line',
        },
        error: null,
      });

      mockSupabase.auth.admin.generateLink.mockResolvedValueOnce({
        data: { properties: { action_link: 'magic-link' } },
        error: null,
      });

      mockSupabase._setUpdateResult({
        data: null,
        error: null,
      });

      await POST(mockRequest);

      // 驗證 from('profiles').update() 被呼叫
      expect(mockSupabase.from).toHaveBeenCalledWith('profiles');
    });
  });
});

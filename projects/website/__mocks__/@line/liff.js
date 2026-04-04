// Mock LIFF SDK for testing

const mockLiff = {
  init: jest.fn(() => Promise.resolve()),

  isLoggedIn: jest.fn(() => true),

  login: jest.fn(),

  logout: jest.fn(),

  getProfile: jest.fn(() =>
    Promise.resolve({
      userId: 'U_TEST_USER_123',
      displayName: 'Test User',
      pictureUrl: 'https://example.com/test-user.jpg',
      statusMessage: 'Test status',
    })
  ),

  getAccessToken: jest.fn(() => 'mock_access_token_12345'),

  getIDToken: jest.fn(() => 'mock_id_token_12345'),

  getDecodedIDToken: jest.fn(() => ({
    sub: 'U_TEST_USER_123',
    name: 'Test User',
    picture: 'https://example.com/test-user.jpg',
  })),

  getContext: jest.fn(() => ({
    type: 'utou',
    userId: 'U_TEST_USER_123',
    viewType: 'full',
  })),

  isInClient: jest.fn(() => true),

  // Helper to reset all mocks
  _reset: function() {
    Object.keys(this).forEach(key => {
      if (typeof this[key]?.mockClear === 'function') {
        this[key].mockClear();
      }
    });
  },

  // Helper to simulate not logged in
  _setNotLoggedIn: function() {
    this.isLoggedIn.mockReturnValue(false);
  },

  // Helper to simulate logged in
  _setLoggedIn: function() {
    this.isLoggedIn.mockReturnValue(true);
  },

  // Helper to simulate init error
  _setInitError: function(error) {
    this.init.mockRejectedValue(error);
  },
};

export default mockLiff;

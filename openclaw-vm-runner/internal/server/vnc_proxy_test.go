package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVNCProxy_MissingSandboxID(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr)

	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	// GET without sandbox_id query param should return 400
	resp, err := http.Get(ts.URL + "/vnc")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusBadRequest, resp.StatusCode)
}

func TestVNCProxy_Unauthorized_NoToken(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr)
	// No token registered — should return 401
	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/vnc?sandbox_id=sb-1")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestVNCProxy_Unauthorized_WrongToken(t *testing.T) {
	mgr := newMockManagerWithVM("sb-1")
	proxy := NewVNCProxy(mgr)
	proxy.RegisterToken("sb-1", "correct-token")

	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	resp, err := http.Get(ts.URL + "/vnc?sandbox_id=sb-1&token=wrong-token")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusUnauthorized, resp.StatusCode)
}

func TestVNCProxy_SandboxNotFound(t *testing.T) {
	mgr := newMockManager() // empty, no sandboxes
	proxy := NewVNCProxy(mgr)
	proxy.RegisterToken("nonexistent", "tok")

	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	// GET with unknown sandbox_id should return 404
	resp, err := http.Get(ts.URL + "/vnc?sandbox_id=nonexistent&token=tok")
	require.NoError(t, err)
	defer resp.Body.Close()
	assert.Equal(t, http.StatusNotFound, resp.StatusCode)
}

func TestVNCProxy_BinarySubprotocol(t *testing.T) {
	mgr := newMockManagerWithVM("sb-1")
	proxy := NewVNCProxy(mgr)

	// Verify the upgrader has binary subprotocol configured
	assert.Contains(t, proxy.upgrader.Subprotocols, "binary",
		"upgrader must advertise binary subprotocol for noVNC compatibility")
}

func TestVNCProxy_VsockDialFailure(t *testing.T) {
	// Create a mock manager with a sandbox whose VsockPath points nowhere
	mgr := newMockManagerWithVM("sb-dial-fail")

	proxy := NewVNCProxy(mgr)
	proxy.RegisterToken("sb-dial-fail", "tok")
	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	// Attempt WebSocket upgrade -- should fail because vsock dial will fail.
	// The server should return 502 Bad Gateway.
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/vnc?sandbox_id=sb-dial-fail&token=tok"
	dialer := websocket.Dialer{Subprotocols: []string{"binary"}}
	_, resp, err := dialer.Dial(wsURL, nil)
	// We expect either a non-nil error or a non-101 response
	if err != nil {
		// The dial failed, check HTTP response
		if resp != nil {
			defer resp.Body.Close()
			assert.Equal(t, http.StatusBadGateway, resp.StatusCode)
		}
		// If resp is nil, the connection was refused, which is also acceptable
		return
	}
	t.Fatal("expected WebSocket dial to fail for unreachable vsock")
}

func TestVNCProxy_VNCPort(t *testing.T) {
	// Verify VNCPort constant is 5900
	assert.Equal(t, uint32(5900), VNCPort)
}

func TestVNCProxy_CheckOrigin_Localhost(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr)

	tests := []struct {
		origin string
		want   bool
	}{
		{"", true},                           // no origin (non-browser)
		{"http://localhost:8080", true},       // localhost
		{"http://127.0.0.1:6080", true},      // loopback IPv4
		{"http://[::1]:6080", true},           // loopback IPv6
		{"http://evil.example.com", false},    // external
		{"http://localhost.evil.com", false},   // subdomain trick
	}

	for _, tt := range tests {
		t.Run(tt.origin, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/vnc", nil)
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			assert.Equal(t, tt.want, proxy.checkOrigin(r))
		})
	}
}

func TestVNCProxy_CheckOrigin_AllowedOrigins(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr, "https://app.example.com")

	tests := []struct {
		origin string
		want   bool
	}{
		{"https://app.example.com", true},
		{"http://localhost:8080", false},      // not in allowed list
		{"https://evil.example.com", false},
	}

	for _, tt := range tests {
		t.Run(tt.origin, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/vnc", nil)
			r.Header.Set("Origin", tt.origin)
			assert.Equal(t, tt.want, proxy.checkOrigin(r))
		})
	}
}

func TestVNCProxy_TokenRegistration(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr)

	proxy.RegisterToken("sb-1", "secret")
	r := httptest.NewRequest("GET", "/vnc?sandbox_id=sb-1&token=secret", nil)
	assert.True(t, proxy.validateToken(r, "sb-1"))

	r2 := httptest.NewRequest("GET", "/vnc?sandbox_id=sb-1&token=wrong", nil)
	assert.False(t, proxy.validateToken(r2, "sb-1"))

	proxy.UnregisterToken("sb-1")
	r3 := httptest.NewRequest("GET", "/vnc?sandbox_id=sb-1&token=secret", nil)
	assert.False(t, proxy.validateToken(r3, "sb-1"))
}

func TestVNCProxy_BearerTokenAuth(t *testing.T) {
	mgr := newMockManager()
	proxy := NewVNCProxy(mgr)
	proxy.RegisterToken("sb-1", "my-secret")

	r := httptest.NewRequest("GET", "/vnc?sandbox_id=sb-1", nil)
	r.Header.Set("Authorization", "Bearer my-secret")
	assert.True(t, proxy.validateToken(r, "sb-1"))

	r2 := httptest.NewRequest("GET", "/vnc?sandbox_id=sb-1", nil)
	r2.Header.Set("Authorization", "Bearer wrong")
	assert.False(t, proxy.validateToken(r2, "sb-1"))
}

func TestVNCProxy_ReadLimit(t *testing.T) {
	// Verify the read limit constant is 1 MiB
	assert.Equal(t, int64(1<<20), vncReadLimit)
}

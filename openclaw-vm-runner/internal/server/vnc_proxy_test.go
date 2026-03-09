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

func TestVNCProxy_SandboxNotFound(t *testing.T) {
	mgr := newMockManager() // empty, no sandboxes
	proxy := NewVNCProxy(mgr)

	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	// GET with unknown sandbox_id should return 404
	resp, err := http.Get(ts.URL + "/vnc?sandbox_id=nonexistent")
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
	ts := httptest.NewServer(http.HandlerFunc(proxy.HandleWS))
	defer ts.Close()

	// Attempt WebSocket upgrade -- should fail because vsock dial will fail.
	// The server should return 502 Bad Gateway.
	wsURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/vnc?sandbox_id=sb-dial-fail"
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

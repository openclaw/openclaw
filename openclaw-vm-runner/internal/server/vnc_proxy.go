package server

import (
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	fcvsock "github.com/firecracker-microvm/firecracker-go-sdk/vsock"
	"github.com/gorilla/websocket"
)

// VNCPort is the vsock port where x11vnc listens inside the guest VM.
const VNCPort = uint32(5900)

const (
	// vncReadLimit is the maximum WebSocket message size (1 MiB).
	vncReadLimit = 1 << 20
	// vncPongWait is the deadline for reading the next pong message.
	vncPongWait = 30 * time.Second
	// vncPingPeriod must be less than vncPongWait.
	vncPingPeriod = (vncPongWait * 9) / 10
	// vncWriteWait is the deadline for writing a single message.
	vncWriteWait = 10 * time.Second
)

// VNCProxy bridges noVNC WebSocket clients to VNC servers inside Firecracker VMs via vsock.
type VNCProxy struct {
	mgr            VMManager
	upgrader       websocket.Upgrader
	allowedOrigins []string

	// mu protects sandboxTokens.
	mu            sync.RWMutex
	sandboxTokens map[string]string // sandbox_id -> token
}

// NewVNCProxy creates a new VNCProxy with the given VM manager.
// allowedOrigins restricts WebSocket connections to the specified origins.
// If empty, only localhost origins are allowed.
func NewVNCProxy(mgr VMManager, allowedOrigins ...string) *VNCProxy {
	p := &VNCProxy{
		mgr:            mgr,
		allowedOrigins: allowedOrigins,
		sandboxTokens:  make(map[string]string),
	}
	p.upgrader = websocket.Upgrader{
		Subprotocols: []string{"binary"},
		CheckOrigin:  p.checkOrigin,
	}
	return p
}

// RegisterToken associates an authentication token with a sandbox ID.
// Clients must present this token to connect to the VNC proxy.
func (p *VNCProxy) RegisterToken(sandboxID, token string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sandboxTokens[sandboxID] = token
}

// UnregisterToken removes the authentication token for a sandbox ID.
func (p *VNCProxy) UnregisterToken(sandboxID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.sandboxTokens, sandboxID)
}

// checkOrigin validates the Origin header against allowed origins.
// If no allowed origins are configured, only localhost origins are permitted.
func (p *VNCProxy) checkOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// No Origin header — allow (non-browser clients).
		return true
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()

	// If explicit allowed origins are configured, check against them.
	if len(p.allowedOrigins) > 0 {
		for _, allowed := range p.allowedOrigins {
			if strings.EqualFold(origin, allowed) {
				return true
			}
		}
		return false
	}

	// Default: only allow localhost origins.
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

// validateToken checks the token query parameter or Authorization header
// against the registered token for the given sandbox.
func (p *VNCProxy) validateToken(r *http.Request, sandboxID string) bool {
	p.mu.RLock()
	expected, ok := p.sandboxTokens[sandboxID]
	p.mu.RUnlock()

	if !ok {
		// No token registered for this sandbox — reject.
		return false
	}

	// Check token query parameter first.
	if token := r.URL.Query().Get("token"); token != "" {
		return token == expected
	}

	// Fall back to Authorization: Bearer <token> header.
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		return strings.TrimPrefix(auth, "Bearer ") == expected
	}

	return false
}

// HandleWS handles WebSocket upgrade requests and bridges them to VNC servers
// inside Firecracker VMs via vsock. The handler expects a sandbox_id query
// parameter and establishes bidirectional binary frame forwarding between the
// WebSocket client and the guest VNC server on vsock port 5900.
func (p *VNCProxy) HandleWS(w http.ResponseWriter, r *http.Request) {
	// 1. Extract sandbox_id from query params
	sandboxID := r.URL.Query().Get("sandbox_id")
	if sandboxID == "" {
		http.Error(w, "missing sandbox_id query parameter", http.StatusBadRequest)
		return
	}

	// 2. Validate authentication token
	if !p.validateToken(r, sandboxID) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	// 3. Look up the sandbox
	entry, err := p.mgr.Get(sandboxID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, "sandbox not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// 4. Dial VNC inside guest via vsock
	vncConn, err := fcvsock.DialContext(r.Context(), entry.VMConfig.VsockPath, VNCPort,
		fcvsock.WithDialTimeout(5*time.Second),
		fcvsock.WithRetryTimeout(10*time.Second),
	)
	if err != nil {
		log.Printf("VNC proxy: failed to dial vsock for sandbox %s: %v", sandboxID, err)
		http.Error(w, "failed to connect to VNC server", http.StatusBadGateway)
		return
	}
	defer vncConn.Close()

	// 5. Upgrade HTTP to WebSocket
	wsConn, err := p.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("VNC proxy: WebSocket upgrade failed for sandbox %s: %v", sandboxID, err)
		return
	}
	defer wsConn.Close()

	// 6. Apply read limit to prevent DoS via oversized messages.
	wsConn.SetReadLimit(vncReadLimit)

	// 7. Set up ping/pong for connection liveness.
	wsConn.SetReadDeadline(time.Now().Add(vncPongWait))
	wsConn.SetPongHandler(func(string) error {
		wsConn.SetReadDeadline(time.Now().Add(vncPongWait))
		return nil
	})

	// 8. Bidirectional bridge
	errc := make(chan error, 2)

	// ws -> vnc: read WebSocket messages, write to VNC connection
	go func() {
		for {
			_, msg, err := wsConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if _, err := vncConn.Write(msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	// vnc -> ws: read from VNC connection, write as WebSocket binary messages
	go func() {
		buf := make([]byte, 64*1024) // 64KB buffer
		ticker := time.NewTicker(vncPingPeriod)
		defer ticker.Stop()

		for {
			n, err := vncConn.Read(buf)
			if n > 0 {
				wsConn.SetWriteDeadline(time.Now().Add(vncWriteWait))
				if wErr := wsConn.WriteMessage(websocket.BinaryMessage, buf[:n]); wErr != nil {
					errc <- wErr
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					errc <- err
				} else {
					errc <- nil
				}
				return
			}

			// Send ping on schedule (non-blocking check).
			select {
			case <-ticker.C:
				wsConn.SetWriteDeadline(time.Now().Add(vncWriteWait))
				if pErr := wsConn.WriteMessage(websocket.PingMessage, nil); pErr != nil {
					errc <- pErr
					return
				}
			default:
			}
		}
	}()

	// Wait for first error from either direction
	<-errc
}

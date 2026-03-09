package server

import (
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	fcvsock "github.com/firecracker-microvm/firecracker-go-sdk/vsock"
	"github.com/gorilla/websocket"
)

// VNCPort is the vsock port where x11vnc listens inside the guest VM.
const VNCPort = uint32(5900)

// VNCProxy bridges noVNC WebSocket clients to VNC servers inside Firecracker VMs via vsock.
type VNCProxy struct {
	mgr      VMManager
	upgrader websocket.Upgrader
}

// NewVNCProxy creates a new VNCProxy with the given VM manager.
func NewVNCProxy(mgr VMManager) *VNCProxy {
	return &VNCProxy{
		mgr: mgr,
		upgrader: websocket.Upgrader{
			Subprotocols: []string{"binary"},
			CheckOrigin:  func(r *http.Request) bool { return true },
		},
	}
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

	// 2. Look up the sandbox
	entry, err := p.mgr.Get(sandboxID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			http.Error(w, "sandbox not found", http.StatusNotFound)
			return
		}
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	// 3. Dial VNC inside guest via vsock
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

	// 4. Upgrade HTTP to WebSocket
	wsConn, err := p.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("VNC proxy: WebSocket upgrade failed for sandbox %s: %v", sandboxID, err)
		return
	}
	defer wsConn.Close()

	// 5. Bidirectional bridge
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
		for {
			n, err := vncConn.Read(buf)
			if n > 0 {
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
		}
	}()

	// Wait for first error from either direction
	<-errc
}

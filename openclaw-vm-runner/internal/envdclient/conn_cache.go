package envdclient

import (
	"context"
	"sync"

	"google.golang.org/grpc"
)

// Dialer is a function that creates a gRPC connection to an envd agent.
// It is injectable for testing -- production code uses DialEnvd, tests
// use a bufconn-based mock dialer.
type Dialer func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error)

// ConnCache provides a per-sandbox cache of gRPC ClientConns to envd agents.
// Connections are lazily dialed on first access and reused on subsequent calls.
// Thread-safe via sync.Map.
type ConnCache struct {
	conns  sync.Map // map[string]*grpc.ClientConn
	dialer Dialer
}

// NewConnCache creates a ConnCache with the given dialer function.
func NewConnCache(dialer Dialer) *ConnCache {
	return &ConnCache{dialer: dialer}
}

// GetOrDial returns the cached gRPC connection for the given sandboxID,
// or dials a new one using the vsockPath if no cached connection exists.
// If two goroutines race on the same sandboxID, the loser's connection
// is closed and the winner's is returned.
func (c *ConnCache) GetOrDial(ctx context.Context, sandboxID, vsockPath string) (*grpc.ClientConn, error) {
	// Fast path: check if already cached.
	if val, ok := c.conns.Load(sandboxID); ok {
		return val.(*grpc.ClientConn), nil
	}

	// Slow path: dial a new connection.
	conn, err := c.dialer(ctx, vsockPath)
	if err != nil {
		return nil, err
	}

	// Store-or-load to handle concurrent dials for the same sandboxID.
	actual, loaded := c.conns.LoadOrStore(sandboxID, conn)
	if loaded {
		// Another goroutine won the race -- close our connection.
		conn.Close()
		return actual.(*grpc.ClientConn), nil
	}

	return conn, nil
}

// Reconnect removes the cached connection for the given sandboxID so that
// the next GetOrDial creates a fresh connection. This is used after snapshot
// restore when the VM's vsock path changes and the old gRPC connection is stale.
// No-op if the sandboxID is not in the cache.
func (c *ConnCache) Reconnect(sandboxID string) {
	c.Remove(sandboxID)
}

// Remove closes and removes the cached connection for the given sandboxID.
// No-op if the sandboxID is not in the cache.
func (c *ConnCache) Remove(sandboxID string) {
	if val, loaded := c.conns.LoadAndDelete(sandboxID); loaded {
		val.(*grpc.ClientConn).Close()
	}
}

// RemoveAll closes and removes all cached connections.
func (c *ConnCache) RemoveAll() {
	c.conns.Range(func(key, value any) bool {
		c.conns.Delete(key)
		value.(*grpc.ClientConn).Close()
		return true
	})
}

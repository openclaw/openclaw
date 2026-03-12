package envdclient

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

const testBufSize = 1024 * 1024

// newMockDialer creates a Dialer that returns real gRPC connections over bufconn.
// Each call to the returned dialer creates a fresh bufconn listener and connection,
// simulating a new vsock connection to a VM.
func newMockDialer(t *testing.T) Dialer {
	t.Helper()
	return func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		lis := bufconn.Listen(testBufSize)

		// Start a minimal gRPC server on the bufconn listener
		s := grpc.NewServer()
		go func() {
			_ = s.Serve(lis)
		}()
		t.Cleanup(func() {
			s.Stop()
			lis.Close()
		})

		conn, err := grpc.NewClient(
			"passthrough:///bufconn",
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return lis.DialContext(ctx)
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
}

func TestConnCache_GetOrDial_CacheHit(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	conn1, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	require.NotNil(t, conn1)

	conn2, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)

	assert.Same(t, conn1, conn2, "second GetOrDial for same sandbox should return cached connection")
}

func TestConnCache_GetOrDial_DifferentSandboxes(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	conn1, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)

	conn2, err := cache.GetOrDial(ctx, "sandbox-2", "/tmp/s2.sock")
	require.NoError(t, err)

	assert.NotSame(t, conn1, conn2, "different sandboxes should have different connections")
}

func TestConnCache_Remove(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	conn1, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	require.NotNil(t, conn1)

	cache.Remove("sandbox-1")

	// After remove, GetOrDial should create a new connection
	conn2, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	assert.NotSame(t, conn1, conn2, "after Remove, GetOrDial should create a new connection")
}

func TestConnCache_RemoveAll(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	conn1, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	require.NotNil(t, conn1)

	conn2, err := cache.GetOrDial(ctx, "sandbox-2", "/tmp/s2.sock")
	require.NoError(t, err)
	require.NotNil(t, conn2)

	cache.RemoveAll()

	// After RemoveAll, GetOrDial should create new connections
	conn3, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	assert.NotSame(t, conn1, conn3, "after RemoveAll, sandbox-1 should get a new connection")

	conn4, err := cache.GetOrDial(ctx, "sandbox-2", "/tmp/s2.sock")
	require.NoError(t, err)
	assert.NotSame(t, conn2, conn4, "after RemoveAll, sandbox-2 should get a new connection")
}

func TestConnCache_Reconnect_RemovesOld(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	// Dial a connection for sandbox-1
	conn1, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)
	require.NotNil(t, conn1)

	// Reconnect should remove the old connection
	cache.Reconnect("sandbox-1")

	// Next GetOrDial should return a NEW connection (not the same pointer)
	conn2, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1-new.sock")
	require.NoError(t, err)
	assert.NotSame(t, conn1, conn2, "after Reconnect, GetOrDial should return a new connection")
}

func TestConnCache_Reconnect_NewConn(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)
	ctx := context.Background()

	// Dial with original path
	_, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1.sock")
	require.NoError(t, err)

	// Reconnect (simulates VM restore with new socket path)
	cache.Reconnect("sandbox-1")

	// GetOrDial with a new vsockPath should work and return a valid connection
	conn, err := cache.GetOrDial(ctx, "sandbox-1", "/tmp/s1-restored.sock")
	require.NoError(t, err)
	assert.NotNil(t, conn, "after Reconnect, GetOrDial with new path should return a working connection")
}

func TestConnCache_Reconnect_NoopIfMissing(t *testing.T) {
	dialer := newMockDialer(t)
	cache := NewConnCache(dialer)

	// Reconnect on a sandboxID that was never dialed should not panic
	assert.NotPanics(t, func() {
		cache.Reconnect("unknown-sandbox")
	}, "Reconnect on unknown sandboxID should be a no-op")
}

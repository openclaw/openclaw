package envdclient

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDialEnvd_ReturnsConn(t *testing.T) {
	// grpc.NewClient is lazy -- it returns a ClientConn without actually
	// dialing. The real connection attempt happens on the first RPC call.
	// So DialEnvd always succeeds; we verify it returns a non-nil conn.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	conn, err := DialEnvd(ctx, "/tmp/nonexistent-vsock-path-for-test.sock")
	require.NoError(t, err)
	require.NotNil(t, conn)
	defer conn.Close()

	// Verify the connection target is the expected passthrough address.
	assert.Equal(t, "passthrough:///vsock", conn.Target())
}

func TestEnvdPort(t *testing.T) {
	assert.Equal(t, uint32(50051), EnvdPort)
}

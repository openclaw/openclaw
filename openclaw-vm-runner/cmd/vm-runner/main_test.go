package main

import (
	"context"
	"net"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/health"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/test/bufconn"
)

const bufSize = 1024 * 1024

// TestHealthServiceRegistration validates the exact health registration pattern
// that main.go will use: standard grpc.health.v1.Health with empty service name.
// This confirms the TypeScript client's health check (empty service name) works.
func TestHealthServiceRegistration(t *testing.T) {
	// Create in-process gRPC server with health service
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()

	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(s, healthServer)
	healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	go func() { _ = s.Serve(lis) }()
	defer s.Stop()

	// Connect client via bufconn
	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	// Check health with empty service name (what the TS client sends)
	client := healthpb.NewHealthClient(conn)
	resp, err := client.Check(context.Background(), &healthpb.HealthCheckRequest{Service: ""})
	require.NoError(t, err)
	assert.Equal(t, healthpb.HealthCheckResponse_SERVING, resp.Status)
}

// TestHealthServiceShutdown validates the shutdown pattern: after calling
// Shutdown(), the health server reports NOT_SERVING for all services.
// This pattern will be used in main.go's graceful shutdown sequence.
func TestHealthServiceShutdown(t *testing.T) {
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()

	healthServer := health.NewServer()
	healthpb.RegisterHealthServer(s, healthServer)
	healthServer.SetServingStatus("", healthpb.HealthCheckResponse_SERVING)

	go func() { _ = s.Serve(lis) }()
	defer s.Stop()

	// Connect client
	dialer := func(context.Context, string) (net.Conn, error) {
		return lis.Dial()
	}
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(dialer),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	client := healthpb.NewHealthClient(conn)

	// Before shutdown: SERVING
	resp, err := client.Check(context.Background(), &healthpb.HealthCheckRequest{Service: ""})
	require.NoError(t, err)
	assert.Equal(t, healthpb.HealthCheckResponse_SERVING, resp.Status)

	// Shutdown sets all services to NOT_SERVING
	healthServer.Shutdown()

	// After shutdown: NOT_SERVING
	resp, err = client.Check(context.Background(), &healthpb.HealthCheckRequest{Service: ""})
	require.NoError(t, err)
	assert.Equal(t, healthpb.HealthCheckResponse_NOT_SERVING, resp.Status)
}

// TestManagerRegistryRemoveIsNoop verifies that Remove does not panic
// even when called on a nil-field registry. This confirms the no-op
// behavior that prevents double-destroy errors.
func TestManagerRegistryRemoveIsNoop(t *testing.T) {
	r := &managerRegistry{}
	// Should not panic even with nil fields
	assert.NotPanics(t, func() {
		r.Remove("any-vm-id")
	})
}

// TestAdapterInterfaceCompliance is a compile-time check (via the var _ lines
// in adapters.go) plus a runtime sanity check that the types are usable.
func TestAdapterInterfaceCompliance(t *testing.T) {
	// This test exists to confirm the adapters compile and the types
	// can be instantiated. The actual interface compliance is enforced
	// at compile time via var _ checks in adapters.go.
	r := &managerRegistry{}
	d := &jailDestroyer{}
	assert.NotNil(t, r)
	assert.NotNil(t, d)
}

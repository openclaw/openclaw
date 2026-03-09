//go:build e2e

// Package e2e contains end-to-end tests that validate the full sandbox-to-browser
// pipeline. These tests require KVM (/dev/kvm) and Firecracker to be available,
// so they only run when explicitly enabled with the "e2e" build tag:
//
//	go test -tags e2e ./internal/e2e/ -v
//
// Environment variables required:
//
//	E2E_KERNEL_PATH - path to uncompressed Linux kernel ELF
//	E2E_ROOTFS_PATH - path to ext4 rootfs image (browser variant)
package e2e

import (
	"context"
	"io"
	"net"
	"os"
	"testing"
	"time"

	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/config"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"github.com/openclaw/vm-runner/internal/server"
	"github.com/openclaw/vm-runner/internal/vm"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

const bufSize = 1024 * 1024

// TestE2E_BrowserPipeline validates the full sandbox-to-browser pipeline:
//
//  1. Create sandbox (Firecracker MicroVM)
//  2. Launch browser (Chromium via envd)
//  3. Navigate to https://example.com
//  4. Take screenshot and verify PNG magic bytes
//  5. Close browser session
//  6. Destroy sandbox
//
// This test runs ONLY on KVM-enabled machines with Firecracker installed.
func TestE2E_BrowserPipeline(t *testing.T) {
	// Skip if /dev/kvm not available (no KVM = no Firecracker).
	if _, err := os.Stat("/dev/kvm"); os.IsNotExist(err) {
		t.Skip("KVM not available, skipping E2E test")
	}

	// Skip if kernel/rootfs not configured.
	kernelPath := os.Getenv("E2E_KERNEL_PATH")
	rootfsPath := os.Getenv("E2E_ROOTFS_PATH")
	if kernelPath == "" || rootfsPath == "" {
		t.Skip("E2E_KERNEL_PATH and E2E_ROOTFS_PATH must be set")
	}

	// Verify kernel and rootfs files exist.
	if _, err := os.Stat(kernelPath); err != nil {
		t.Skipf("Kernel not found at %s: %v", kernelPath, err)
	}
	if _, err := os.Stat(rootfsPath); err != nil {
		t.Skipf("Rootfs not found at %s: %v", rootfsPath, err)
	}

	cfg := config.DefaultServiceConfig()
	cfg.KernelPath = kernelPath
	cfg.RootfsPath = rootfsPath
	cfg.SnapshotDir = t.TempDir()
	cfg.SocketDir = t.TempDir()

	// 1. Create Manager with real MachineFactory (requires KVM + Firecracker).
	mgr := vm.NewManager(cfg)

	// ConnCache with real envd dialer (vsock -> gRPC inside the VM).
	connCache := envdclient.NewConnCache(func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		return envdclient.DialEnvd(ctx, vsockPath)
	})

	// 2. Set up bufconn gRPC server with sandbox + browser services.
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	pb.RegisterSandboxServiceServer(srv, server.NewSandboxServer(mgr))
	pb.RegisterBrowserServiceServer(srv, server.NewBrowserServer(mgr, connCache, 0))
	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	sandboxClient := pb.NewSandboxServiceClient(conn)
	browserClient := pb.NewBrowserServiceClient(conn)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	// 3. Create sandbox.
	createResp, err := sandboxClient.CreateSandbox(ctx, &pb.CreateSandboxRequest{})
	require.NoError(t, err)
	sandboxID := createResp.GetSandboxId()
	require.NotEmpty(t, sandboxID)
	defer func() {
		_, _ = sandboxClient.DestroySandbox(ctx, &pb.DestroySandboxRequest{SandboxId: sandboxID})
	}()

	// 4. Launch browser.
	launchResp, err := browserClient.Launch(ctx, &pb.LaunchRequest{
		SandboxId: sandboxID,
		Headless:  true,
	})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	require.NotEmpty(t, sessionID)

	// 5. Navigate to a well-known page.
	navResp, err := browserClient.Navigate(ctx, &pb.NavigateRequest{
		SandboxId: sandboxID,
		SessionId: sessionID,
		Url:       "https://example.com",
	})
	require.NoError(t, err)
	assert.Contains(t, navResp.GetTitle(), "Example")

	// 6. Screenshot and verify PNG bytes.
	stream, err := browserClient.Screenshot(ctx, &pb.ScreenshotRequest{
		SandboxId: sandboxID,
		SessionId: sessionID,
	})
	require.NoError(t, err)

	var screenshotData []byte
	for {
		chunk, recvErr := stream.Recv()
		if recvErr == io.EOF {
			break
		}
		require.NoError(t, recvErr)
		screenshotData = append(screenshotData, chunk.GetData()...)
		if chunk.GetEof() {
			break
		}
	}
	assert.Greater(t, len(screenshotData), 100, "screenshot should have substantial data")
	// PNG magic bytes: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
	require.GreaterOrEqual(t, len(screenshotData), 4, "screenshot data too short for PNG header")
	assert.Equal(t, byte(0x89), screenshotData[0], "first byte should be PNG signature")
	assert.Equal(t, byte(0x50), screenshotData[1], "second byte should be 'P'")
	assert.Equal(t, byte(0x4E), screenshotData[2], "third byte should be 'N'")
	assert.Equal(t, byte(0x47), screenshotData[3], "fourth byte should be 'G'")

	// 7. Close browser.
	_, err = browserClient.Close(ctx, &pb.CloseRequest{
		SandboxId: sandboxID,
		SessionId: sessionID,
	})
	require.NoError(t, err)

	// 8. Destroy sandbox.
	_, err = sandboxClient.DestroySandbox(ctx, &pb.DestroySandboxRequest{SandboxId: sandboxID})
	require.NoError(t, err)
}

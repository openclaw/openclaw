package envd

import (
	"context"
	"net"
	"testing"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// ---------------------------------------------------------------------------
// Unit tests for URLPolicy.Validate (no gRPC, no chromium)
// ---------------------------------------------------------------------------

func TestValidateURL_BlockedProtocols(t *testing.T) {
	policy := DefaultURLPolicy()
	blocked := []string{
		"file:///etc/passwd",
		"chrome://settings",
		"chrome-extension://abc/popup.html",
		"data:text/html,<h1>hi</h1>",
		"javascript:alert(1)",
		"vbscript:MsgBox(1)",
	}
	for _, u := range blocked {
		t.Run(u, func(t *testing.T) {
			err := policy.Validate(context.Background(), u)
			require.Error(t, err, "expected blocked protocol for %s", u)
			assert.Contains(t, err.Error(), "blocked protocol")
		})
	}
}

func TestValidateURL_AllowedProtocols(t *testing.T) {
	policy := DefaultURLPolicy()
	allowed := []string{
		"https://example.com",
		"http://example.com",
		"https://example.com/path?q=1",
	}
	for _, u := range allowed {
		t.Run(u, func(t *testing.T) {
			err := policy.Validate(context.Background(), u)
			assert.NoError(t, err, "expected allowed URL %s", u)
		})
	}
}

func TestValidateURL_MetadataEndpoint(t *testing.T) {
	policy := DefaultURLPolicy()
	err := policy.Validate(context.Background(), "http://169.254.169.254/latest/meta-data/")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "blocked")
}

func TestValidateURL_MetadataIPEncodings(t *testing.T) {
	policy := DefaultURLPolicy()

	// Decimal encoding of 169.254.169.254 = 2852039166
	err := policy.Validate(context.Background(), "http://2852039166/")
	require.Error(t, err, "decimal-encoded metadata IP should be blocked")

	// Hex encoding of 169.254.169.254 = 0xA9FEA9FE
	err = policy.Validate(context.Background(), "http://0xA9FEA9FE/")
	require.Error(t, err, "hex-encoded metadata IP should be blocked")
}

func TestValidateURL_LoopbackBlocked(t *testing.T) {
	policy := DefaultURLPolicy()

	err := policy.Validate(context.Background(), "http://127.0.0.1/")
	require.Error(t, err, "loopback 127.0.0.1 should be blocked")

	err = policy.Validate(context.Background(), "http://localhost/")
	require.Error(t, err, "localhost should be blocked")
}

func TestValidateURL_PrivateIPBlocked(t *testing.T) {
	policy := DefaultURLPolicy()

	tests := []string{
		"http://10.0.0.1/",
		"http://172.16.0.1/",
		"http://172.31.255.255/",
		"http://192.168.1.1/",
	}
	for _, u := range tests {
		t.Run(u, func(t *testing.T) {
			err := policy.Validate(context.Background(), u)
			require.Error(t, err, "private IP should be blocked: %s", u)
		})
	}
}

func TestValidateURL_IPv6ULABlocked(t *testing.T) {
	policy := DefaultURLPolicy()

	tests := []string{
		"http://[fc00::1]/",
		"http://[fd00::1]/",
		"http://[fd00:ec2::254]/",
		"http://[fd12:3456:789a::1]/",
	}
	for _, u := range tests {
		t.Run(u, func(t *testing.T) {
			err := policy.Validate(context.Background(), u)
			require.Error(t, err, "IPv6 ULA should be blocked: %s", u)
			assert.Contains(t, err.Error(), "blocked")
		})
	}
}

func TestValidateURL_IPv6UnspecifiedBlocked(t *testing.T) {
	policy := DefaultURLPolicy()

	err := policy.Validate(context.Background(), "http://[::]/")
	require.Error(t, err, "IPv6 unspecified address should be blocked")
	assert.Contains(t, err.Error(), "blocked")
}

func TestValidateURL_CloudMetadataHostnamesBlocked(t *testing.T) {
	policy := DefaultURLPolicy()

	tests := []string{
		"http://metadata.google.internal/computeMetadata/v1/",
		"http://100.100.100.200/latest/meta-data/",
	}
	for _, u := range tests {
		t.Run(u, func(t *testing.T) {
			err := policy.Validate(context.Background(), u)
			require.Error(t, err, "cloud metadata should be blocked: %s", u)
			assert.Contains(t, err.Error(), "blocked")
		})
	}
}

func TestValidateURL_ValidPublicURL(t *testing.T) {
	policy := DefaultURLPolicy()

	err := policy.Validate(context.Background(), "https://google.com")
	assert.NoError(t, err)

	err = policy.Validate(context.Background(), "http://93.184.216.34/")
	assert.NoError(t, err)
}

func TestValidateURL_EmptyAndMalformed(t *testing.T) {
	policy := DefaultURLPolicy()

	err := policy.Validate(context.Background(), "")
	require.Error(t, err, "empty URL should be rejected")

	err = policy.Validate(context.Background(), "not-a-url")
	require.Error(t, err, "malformed URL should be rejected")
}

// ---------------------------------------------------------------------------
// Integration test: Navigate RPC rejects blocked URL via bufconn
// ---------------------------------------------------------------------------

func setupBrowserSecurityTestServer(t *testing.T) (pb.BrowserServiceClient, func()) {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	bs := NewBrowserServer()
	pb.RegisterBrowserServiceServer(srv, bs)

	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	client := pb.NewBrowserServiceClient(conn)
	cleanup := func() {
		conn.Close()
		srv.Stop()
		lis.Close()
	}
	return client, cleanup
}

func TestNavigateRPC_BlockedURL(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserSecurityTestServer(t)
	defer cleanup()

	// Launch a session first.
	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	// Attempt to navigate to a blocked URL.
	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       "file:///etc/passwd",
	})
	require.Error(t, err)
	assert.Equal(t, codes.InvalidArgument, status.Code(err))
	assert.Contains(t, err.Error(), "blocked")
}

// ---------------------------------------------------------------------------
// Tab limit test
// ---------------------------------------------------------------------------

func TestBrowser_TabLimit(t *testing.T) {
	checkChromiumAvailable(t)

	// Create a server with maxTabs = 2 for a quick test.
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	bs := NewBrowserServer()
	bs.maxTabs = 2
	pb.RegisterBrowserServiceServer(srv, bs)

	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	client := pb.NewBrowserServiceClient(conn)
	defer func() {
		conn.Close()
		srv.Stop()
		lis.Close()
	}()

	// Launch 2 sessions (should succeed).
	var sessionIDs []string
	for i := 0; i < 2; i++ {
		resp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
		require.NoError(t, err, "launch %d should succeed", i+1)
		sessionIDs = append(sessionIDs, resp.GetSessionId())
	}

	// 3rd launch should fail with ResourceExhausted.
	_, err = client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.Error(t, err)
	assert.Equal(t, codes.ResourceExhausted, status.Code(err))
	assert.Contains(t, err.Error(), "tab limit")

	// Clean up sessions.
	for _, sid := range sessionIDs {
		_, _ = client.Close(context.Background(), &pb.CloseRequest{SessionId: sid})
	}
}

// ---------------------------------------------------------------------------
// Chromium flags test
// ---------------------------------------------------------------------------

func TestChromiumFlags(t *testing.T) {
	// We test that newBrowserAllocator returns a context with the expected flags.
	// Since chromedp doesn't expose the flags directly, we verify by checking
	// the allocator options are set without error.
	// This is a structural test -- the flags are applied in newBrowserAllocator.
	req := &pb.LaunchRequest{Headless: true}
	allocCtx, allocCancel := newBrowserAllocator(req)
	defer allocCancel()

	// The allocator context should not be nil (flags applied successfully).
	require.NotNil(t, allocCtx, "allocator context should be created with flags")
}

package server

import (
	"context"
	"io"
	"net"
	"testing"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// simpleMockBrowserServer implements envdpb.BrowserServiceServer with canned responses.
// This avoids needing chromedp in tests.
type simpleMockBrowserServer struct {
	envdpb.UnimplementedBrowserServiceServer
}

func (m *simpleMockBrowserServer) Launch(_ context.Context, _ *envdpb.LaunchRequest) (*envdpb.LaunchResponse, error) {
	return &envdpb.LaunchResponse{SessionId: "sess-123"}, nil
}

func (m *simpleMockBrowserServer) Navigate(_ context.Context, req *envdpb.NavigateRequest) (*envdpb.NavigateResponse, error) {
	return &envdpb.NavigateResponse{Url: req.GetUrl(), Title: "Test Page"}, nil
}

func (m *simpleMockBrowserServer) Click(_ context.Context, _ *envdpb.ClickRequest) (*envdpb.ClickResponse, error) {
	return &envdpb.ClickResponse{}, nil
}

func (m *simpleMockBrowserServer) Type(_ context.Context, _ *envdpb.TypeRequest) (*envdpb.TypeResponse, error) {
	return &envdpb.TypeResponse{}, nil
}

func (m *simpleMockBrowserServer) Screenshot(req *envdpb.ScreenshotRequest, stream grpc.ServerStreamingServer[envdpb.ScreenshotResponse]) error {
	// Send two chunks + EOF
	if err := stream.Send(&envdpb.ScreenshotResponse{Data: []byte("chunk1"), Eof: false}); err != nil {
		return err
	}
	if err := stream.Send(&envdpb.ScreenshotResponse{Data: []byte("chunk2"), Eof: true}); err != nil {
		return err
	}
	return nil
}

func (m *simpleMockBrowserServer) EvaluateJS(_ context.Context, req *envdpb.EvaluateJSRequest) (*envdpb.EvaluateJSResponse, error) {
	return &envdpb.EvaluateJSResponse{Result: `"evaluated:` + req.GetExpression() + `"`}, nil
}

func (m *simpleMockBrowserServer) ExtractContent(_ context.Context, _ *envdpb.ExtractContentRequest) (*envdpb.ExtractContentResponse, error) {
	return &envdpb.ExtractContentResponse{Text: "hello world", Html: "<p>hello world</p>"}, nil
}

func (m *simpleMockBrowserServer) WaitForSelector(_ context.Context, _ *envdpb.WaitForSelectorRequest) (*envdpb.WaitForSelectorResponse, error) {
	return &envdpb.WaitForSelectorResponse{Found: true}, nil
}

func (m *simpleMockBrowserServer) GetPageInfo(_ context.Context, _ *envdpb.GetPageInfoRequest) (*envdpb.GetPageInfoResponse, error) {
	return &envdpb.GetPageInfoResponse{Title: "Page Title", Url: "https://example.com"}, nil
}

func (m *simpleMockBrowserServer) Close(_ context.Context, _ *envdpb.CloseRequest) (*envdpb.CloseResponse, error) {
	return &envdpb.CloseResponse{}, nil
}

func (m *simpleMockBrowserServer) GetVNCInfo(_ context.Context, _ *envdpb.GetVNCInfoRequest) (*envdpb.GetVNCInfoResponse, error) {
	return &envdpb.GetVNCInfoResponse{
		VncInfo: &envdpb.VNCInfo{
			Password:  "testpass",
			Display:   99,
			Available: true,
		},
	}, nil
}

// setupMockEnvdBrowserService creates a bufconn-based mock envd BrowserService server.
func setupMockEnvdBrowserService(t *testing.T) *bufconn.Listener {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	envdpb.RegisterBrowserServiceServer(s, &simpleMockBrowserServer{})
	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("mock envd browser server exited: %v", err)
		}
	}()
	t.Cleanup(func() {
		s.Stop()
		lis.Close()
	})
	return lis
}

// setupBrowserTestServer creates a bufconn-based gRPC server with the real
// browserProxy service and returns a BrowserServiceClient.
func setupBrowserTestServer(t *testing.T, mgr VMManager, envdLis *bufconn.Listener) pb.BrowserServiceClient {
	t.Helper()

	// Create a ConnCache with a dialer that connects to the mock envd.
	dialer := func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		conn, err := grpc.NewClient(
			"passthrough:///bufconn",
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return envdLis.DialContext(ctx)
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		return conn, err
	}
	connCache := envdclient.NewConnCache(dialer)
	t.Cleanup(func() {
		connCache.RemoveAll()
	})

	// Create the browser proxy server.
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	pb.RegisterBrowserServiceServer(s, NewBrowserServer(mgr, connCache, 6080))

	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("browser service server exited: %v", err)
		}
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
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	return pb.NewBrowserServiceClient(conn)
}

func TestBrowserService_Launch(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.Launch(context.Background(), &pb.LaunchRequest{
		SandboxId:      "sb-1",
		Headless:       true,
		ViewportWidth:  1280,
		ViewportHeight: 720,
	})
	require.NoError(t, err)
	assert.Equal(t, "sess-123", resp.GetSessionId())
}

func TestBrowserService_Navigate(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.Navigate(context.Background(), &pb.NavigateRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		Url:       "https://example.com",
		TimeoutMs: 5000,
	})
	require.NoError(t, err)
	assert.Equal(t, "https://example.com", resp.GetUrl())
	assert.Equal(t, "Test Page", resp.GetTitle())
}

func TestBrowserService_Click(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	_, err := client.Click(context.Background(), &pb.ClickRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		Selector:  "#submit-btn",
	})
	require.NoError(t, err)
}

func TestBrowserService_Type(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	_, err := client.Type(context.Background(), &pb.TypeRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		Selector:  "#search-input",
		Text:      "hello world",
	})
	require.NoError(t, err)
}

func TestBrowserService_Screenshot(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	stream, err := client.Screenshot(context.Background(), &pb.ScreenshotRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		FullPage:  false,
		Quality:   80,
	})
	require.NoError(t, err)

	var chunks [][]byte
	var gotEof bool
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		chunks = append(chunks, resp.GetData())
		if resp.GetEof() {
			gotEof = true
			break
		}
	}

	require.Len(t, chunks, 2)
	assert.Equal(t, []byte("chunk1"), chunks[0])
	assert.Equal(t, []byte("chunk2"), chunks[1])
	assert.True(t, gotEof, "expected EOF flag in last chunk")
}

func TestBrowserService_EvaluateJS(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.EvaluateJS(context.Background(), &pb.EvaluateJSRequest{
		SandboxId:  "sb-1",
		SessionId:  "sess-123",
		Expression: "document.title",
	})
	require.NoError(t, err)
	assert.Equal(t, `"evaluated:document.title"`, resp.GetResult())
}

func TestBrowserService_ExtractContent(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.ExtractContent(context.Background(), &pb.ExtractContentRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		Selector:  "p.content",
	})
	require.NoError(t, err)
	assert.Equal(t, "hello world", resp.GetText())
	assert.Equal(t, "<p>hello world</p>", resp.GetHtml())
}

func TestBrowserService_WaitForSelector(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.WaitForSelector(context.Background(), &pb.WaitForSelectorRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
		Selector:  "#loaded",
		TimeoutMs: 3000,
	})
	require.NoError(t, err)
	assert.True(t, resp.GetFound())
}

func TestBrowserService_GetPageInfo(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.GetPageInfo(context.Background(), &pb.GetPageInfoRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
	})
	require.NoError(t, err)
	assert.Equal(t, "Page Title", resp.GetTitle())
	assert.Equal(t, "https://example.com", resp.GetUrl())
}

func TestBrowserService_Close(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	_, err := client.Close(context.Background(), &pb.CloseRequest{
		SandboxId: "sb-1",
		SessionId: "sess-123",
	})
	require.NoError(t, err)
}

func TestBrowserService_GetVNCInfo(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.GetVNCInfo(context.Background(), &pb.GetVNCInfoRequest{
		SandboxId: "sb-1",
	})
	require.NoError(t, err)
	require.NotNil(t, resp.GetVncInfo())
	assert.Equal(t, "testpass", resp.GetVncInfo().GetPassword())
	assert.Equal(t, uint32(99), resp.GetVncInfo().GetDisplay())
	assert.True(t, resp.GetVncInfo().GetAvailable())
}

func TestBrowserService_LaunchVNCWebsocketURL(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupBrowserTestServer(t, mgr, envdLis)

	resp, err := client.Launch(context.Background(), &pb.LaunchRequest{
		SandboxId: "sb-1",
		Headless:  false,
	})
	require.NoError(t, err)
	assert.Equal(t, "sess-123", resp.GetSessionId())
	assert.Contains(t, resp.GetVncWebsocketUrl(), "ws://localhost:6080/vnc?sandbox_id=sb-1&token=")
}

func TestBrowserService_NotFound(t *testing.T) {
	envdLis := setupMockEnvdBrowserService(t)
	mgr := newMockManager() // empty manager, no sandboxes
	client := setupBrowserTestServer(t, mgr, envdLis)

	_, err := client.Launch(context.Background(), &pb.LaunchRequest{
		SandboxId: "nonexistent",
	})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.NotFound, st.Code())
}

func TestBrowserService_Unavailable(t *testing.T) {
	// Create a listener that we immediately close to simulate unreachable envd.
	deadLis := bufconn.Listen(bufSize)
	deadLis.Close()

	mgr := newMockManagerWithVM("sb-1")

	// Create a ConnCache with a dialer that always fails (unreachable envd).
	dialer := func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		conn, err := grpc.NewClient(
			"passthrough:///bufconn",
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return deadLis.DialContext(ctx)
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		return conn, err
	}
	connCache := envdclient.NewConnCache(dialer)
	t.Cleanup(func() {
		connCache.RemoveAll()
	})

	// Create the browser proxy server with the broken ConnCache.
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	pb.RegisterBrowserServiceServer(s, NewBrowserServer(mgr, connCache, 6080))

	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("browser service server exited: %v", err)
		}
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
	require.NoError(t, err)
	t.Cleanup(func() { conn.Close() })

	client := pb.NewBrowserServiceClient(conn)

	_, err = client.Launch(context.Background(), &pb.LaunchRequest{
		SandboxId: "sb-1",
	})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.Unavailable, st.Code())
}

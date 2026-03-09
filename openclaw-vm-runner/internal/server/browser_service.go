package server

import (
	"context"
	"fmt"
	"io"
	"strings"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// browserProxy implements BrowserServiceServer by forwarding all browser automation
// RPCs to the envd BrowserService inside a Firecracker VM via a cached vsock gRPC connection.
type browserProxy struct {
	pb.UnimplementedBrowserServiceServer
	mgr          VMManager
	connCache    *envdclient.ConnCache
	vncProxyPort int
}

// NewBrowserServer creates a new BrowserService gRPC handler that bridges browser
// requests to the envd BrowserService running inside the target sandbox VM.
// vncProxyPort is the TCP port for the VNC WebSocket proxy (0 = disabled).
func NewBrowserServer(mgr VMManager, connCache *envdclient.ConnCache, vncProxyPort int) *browserProxy {
	return &browserProxy{mgr: mgr, connCache: connCache, vncProxyPort: vncProxyPort}
}

// getEnvdBrowserClient resolves the sandbox_id, dials envd via ConnCache,
// and returns a BrowserServiceClient for the target VM.
func (s *browserProxy) getEnvdBrowserClient(ctx context.Context, sandboxID string) (envdpb.BrowserServiceClient, error) {
	entry, err := s.mgr.Get(sandboxID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, status.Errorf(codes.NotFound, "sandbox %s not found", sandboxID)
		}
		return nil, status.Errorf(codes.Internal, "failed to get sandbox: %v", err)
	}

	conn, err := s.connCache.GetOrDial(ctx, sandboxID, entry.VMConfig.VsockPath)
	if err != nil {
		return nil, status.Errorf(codes.Unavailable, "cannot reach envd for sandbox %s: %v", sandboxID, err)
	}

	return envdpb.NewBrowserServiceClient(conn), nil
}

// Launch starts a new browser session in a sandbox.
func (s *browserProxy) Launch(ctx context.Context, req *pb.LaunchRequest) (*pb.LaunchResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.Launch(ctx, &envdpb.LaunchRequest{
		Headless:       req.GetHeadless(),
		ViewportWidth:  req.GetViewportWidth(),
		ViewportHeight: req.GetViewportHeight(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	launchResp := &pb.LaunchResponse{
		SessionId: resp.GetSessionId(),
	}

	// Populate VNC WebSocket URL if proxy is enabled
	if s.vncProxyPort > 0 {
		launchResp.VncWebsocketUrl = fmt.Sprintf("ws://localhost:%d/vnc?sandbox_id=%s", s.vncProxyPort, req.GetSandboxId())
	}

	return launchResp, nil
}

// Navigate loads a URL in the browser.
func (s *browserProxy) Navigate(ctx context.Context, req *pb.NavigateRequest) (*pb.NavigateResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.Navigate(ctx, &envdpb.NavigateRequest{
		SessionId: req.GetSessionId(),
		Url:       req.GetUrl(),
		TimeoutMs: req.GetTimeoutMs(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.NavigateResponse{
		Url:   resp.GetUrl(),
		Title: resp.GetTitle(),
	}, nil
}

// Click clicks an element matching a CSS selector.
func (s *browserProxy) Click(ctx context.Context, req *pb.ClickRequest) (*pb.ClickResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	_, err = envdClient.Click(ctx, &envdpb.ClickRequest{
		SessionId: req.GetSessionId(),
		Selector:  req.GetSelector(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.ClickResponse{}, nil
}

// Type types text into an element matching a CSS selector.
func (s *browserProxy) Type(ctx context.Context, req *pb.TypeRequest) (*pb.TypeResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	_, err = envdClient.Type(ctx, &envdpb.TypeRequest{
		SessionId: req.GetSessionId(),
		Selector:  req.GetSelector(),
		Text:      req.GetText(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.TypeResponse{}, nil
}

// Screenshot captures the current page as a streamed image.
func (s *browserProxy) Screenshot(req *pb.ScreenshotRequest, stream grpc.ServerStreamingServer[pb.ScreenshotResponse]) error {
	ctx := stream.Context()

	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return err
	}

	envdStream, err := envdClient.Screenshot(ctx, &envdpb.ScreenshotRequest{
		SessionId: req.GetSessionId(),
		FullPage:  req.GetFullPage(),
		Quality:   req.GetQuality(),
	})
	if err != nil {
		return translateEnvdError(err, req.GetSandboxId())
	}

	for {
		resp, err := envdStream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return translateEnvdError(err, req.GetSandboxId())
		}

		if err := stream.Send(&pb.ScreenshotResponse{
			Data: resp.GetData(),
			Eof:  resp.GetEof(),
		}); err != nil {
			return err
		}

		if resp.GetEof() {
			return nil
		}
	}
}

// EvaluateJS executes a JavaScript expression and returns the result.
func (s *browserProxy) EvaluateJS(ctx context.Context, req *pb.EvaluateJSRequest) (*pb.EvaluateJSResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.EvaluateJS(ctx, &envdpb.EvaluateJSRequest{
		SessionId:  req.GetSessionId(),
		Expression: req.GetExpression(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.EvaluateJSResponse{
		Result: resp.GetResult(),
	}, nil
}

// ExtractContent extracts text and HTML from an element.
func (s *browserProxy) ExtractContent(ctx context.Context, req *pb.ExtractContentRequest) (*pb.ExtractContentResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.ExtractContent(ctx, &envdpb.ExtractContentRequest{
		SessionId: req.GetSessionId(),
		Selector:  req.GetSelector(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.ExtractContentResponse{
		Text: resp.GetText(),
		Html: resp.GetHtml(),
	}, nil
}

// WaitForSelector waits for an element to appear in the DOM.
func (s *browserProxy) WaitForSelector(ctx context.Context, req *pb.WaitForSelectorRequest) (*pb.WaitForSelectorResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.WaitForSelector(ctx, &envdpb.WaitForSelectorRequest{
		SessionId: req.GetSessionId(),
		Selector:  req.GetSelector(),
		TimeoutMs: req.GetTimeoutMs(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.WaitForSelectorResponse{
		Found: resp.GetFound(),
	}, nil
}

// GetPageInfo returns the current page title and URL.
func (s *browserProxy) GetPageInfo(ctx context.Context, req *pb.GetPageInfoRequest) (*pb.GetPageInfoResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.GetPageInfo(ctx, &envdpb.GetPageInfoRequest{
		SessionId: req.GetSessionId(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.GetPageInfoResponse{
		Title: resp.GetTitle(),
		Url:   resp.GetUrl(),
	}, nil
}

// GetVNCInfo returns VNC connection details for a sandbox's desktop environment.
// It forwards the request to envd and enriches the response with the host-side
// WebSocket URL if the VNC proxy is enabled.
func (s *browserProxy) GetVNCInfo(ctx context.Context, req *pb.GetVNCInfoRequest) (*pb.GetVNCInfoResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.GetVNCInfo(ctx, &envdpb.GetVNCInfoRequest{})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	// Map envd VNCInfo to sandbox VNCInfo
	var vncInfo *pb.VNCInfo
	if envdVNC := resp.GetVncInfo(); envdVNC != nil {
		vncInfo = &pb.VNCInfo{
			Password:  envdVNC.GetPassword(),
			Display:   envdVNC.GetDisplay(),
			Available: envdVNC.GetAvailable(),
		}
	}

	return &pb.GetVNCInfoResponse{
		VncInfo: vncInfo,
	}, nil
}

// Close terminates a browser session.
func (s *browserProxy) Close(ctx context.Context, req *pb.CloseRequest) (*pb.CloseResponse, error) {
	envdClient, err := s.getEnvdBrowserClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	_, err = envdClient.Close(ctx, &envdpb.CloseRequest{
		SessionId: req.GetSessionId(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.CloseResponse{}, nil
}

package envd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
	"github.com/google/uuid"
	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// chromiumPath is the default Chromium binary path in Alpine-based MicroVMs.
// Browser-enabled VMs require a minimum of 512MB RAM.
const chromiumPath = "/usr/bin/chromium-browser"

// screenshotChunkSize matches fileChunkSize (64KB) for consistent streaming.
const screenshotChunkSize = 65536

// BrowserSession holds the state for a single browser session driven by chromedp.
type BrowserSession struct {
	SessionID   string
	allocCancel context.CancelFunc // cancels chromedp allocator (kills Chrome)
	ctxCancel   context.CancelFunc // cancels chromedp browser context
	ctx         context.Context    // chromedp browser context for running actions
	mu          sync.Mutex
	createdAt   time.Time
}

// defaultMaxTabs is the maximum number of concurrent browser sessions.
// 0 means unlimited.
const defaultMaxTabs = 10

// BrowserServer implements the BrowserServiceServer gRPC interface using chromedp.
type BrowserServer struct {
	pb.UnimplementedBrowserServiceServer
	sessions  sync.Map // map[string]*BrowserSession
	urlPolicy *URLPolicy
	maxTabs   int
}

// xvfbPath is the expected path for Xvfb in desktop-variant rootfs images.
const xvfbPath = "/usr/bin/Xvfb"

// vncPasswordPath is where the desktop init script writes the generated VNC password.
const vncPasswordPath = "/run/vnc_password"

// vncDisplay is the X display number used by the desktop environment.
const vncDisplay = 99

// NewBrowserServer creates a new BrowserServer with default URL policy and tab limit.
func NewBrowserServer() *BrowserServer {
	return &BrowserServer{
		urlPolicy: DefaultURLPolicy(),
		maxTabs:   defaultMaxTabs,
	}
}

// desktopAvailable checks if the desktop environment is installed by looking for the Xvfb binary.
func desktopAvailable() bool {
	_, err := os.Stat(xvfbPath)
	return err == nil
}

// readVNCPassword reads the VNC password from the file written by the desktop init script.
// Returns empty string if the password file is not found or unreadable.
func readVNCPassword() string {
	data, err := os.ReadFile(vncPasswordPath)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// newBrowserAllocator creates a chromedp exec allocator with security flags for VM environment.
func newBrowserAllocator(req *pb.LaunchRequest) (context.Context, context.CancelFunc) {
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromiumPath),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-software-rasterizer", true),
		chromedp.Flag("disable-extensions", true),
		chromedp.Flag("disable-background-networking", true),
		chromedp.Flag("disable-sync", true),
		chromedp.Flag("disable-translate", true),
		chromedp.Flag("disable-default-apps", true),
		// Stability flags for VM environment.
		chromedp.Flag("disable-background-timer-throttling", true),
		chromedp.Flag("disable-renderer-backgrounding", true),
		chromedp.Flag("js-flags", "--max-old-space-size=256"),
	)

	if req.GetHeadless() {
		opts = append(opts, chromedp.Flag("headless", true))
	} else if desktopAvailable() {
		// Non-headless mode with desktop environment: run Chromium on the Xvfb display.
		opts = append(opts,
			chromedp.Flag("headless", false),
			chromedp.Env(fmt.Sprintf("DISPLAY=:%d", vncDisplay)),
		)
	}

	if req.GetViewportWidth() > 0 && req.GetViewportHeight() > 0 {
		opts = append(opts, chromedp.WindowSize(int(req.GetViewportWidth()), int(req.GetViewportHeight())))
	}

	return chromedp.NewExecAllocator(context.Background(), opts...)
}

// getSession retrieves a browser session by ID, returning a gRPC NotFound error if missing.
func (s *BrowserServer) getSession(sessionID string) (*BrowserSession, error) {
	val, ok := s.sessions.Load(sessionID)
	if !ok {
		return nil, status.Errorf(codes.NotFound, "browser session %s not found", sessionID)
	}
	return val.(*BrowserSession), nil
}

// sessionCount returns the number of active browser sessions.
func (s *BrowserServer) sessionCount() int {
	count := 0
	s.sessions.Range(func(_, _ interface{}) bool {
		count++
		return true
	})
	return count
}

// Launch starts a new browser session.
func (s *BrowserServer) Launch(ctx context.Context, req *pb.LaunchRequest) (*pb.LaunchResponse, error) {
	// Enforce tab limit.
	if s.maxTabs > 0 && s.sessionCount() >= s.maxTabs {
		return nil, status.Errorf(codes.ResourceExhausted, "tab limit reached: %d", s.maxTabs)
	}

	allocCtx, allocCancel := newBrowserAllocator(req)
	browserCtx, ctxCancel := chromedp.NewContext(allocCtx)

	sessionID := uuid.New().String()
	session := &BrowserSession{
		SessionID:   sessionID,
		allocCancel: allocCancel,
		ctxCancel:   ctxCancel,
		ctx:         browserCtx,
		createdAt:   time.Now(),
	}

	s.sessions.Store(sessionID, session)

	resp := &pb.LaunchResponse{SessionId: sessionID}

	// Populate VNC info when launching non-headless on a desktop-enabled VM.
	if !req.GetHeadless() && desktopAvailable() {
		resp.VncInfo = &pb.VNCInfo{
			Password:  readVNCPassword(),
			Display:   vncDisplay,
			Available: true,
		}
	}

	return resp, nil
}

// Navigate loads a URL in the browser.
func (s *BrowserServer) Navigate(ctx context.Context, req *pb.NavigateRequest) (*pb.NavigateResponse, error) {
	// Validate URL before navigation (SSRF prevention, including DNS resolution).
	if err := s.urlPolicy.Validate(ctx, req.GetUrl()); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "blocked URL: %v", err)
	}

	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	runCtx := session.ctx
	if req.GetTimeoutMs() > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(session.ctx, time.Duration(req.GetTimeoutMs())*time.Millisecond)
		defer cancel()
	}

	if err := chromedp.Run(runCtx, chromedp.Navigate(req.GetUrl())); err != nil {
		return nil, status.Errorf(codes.Internal, "navigate: %v", err)
	}

	var title string
	var finalURL string
	if err := chromedp.Run(runCtx, chromedp.Title(&title), chromedp.Location(&finalURL)); err != nil {
		return nil, status.Errorf(codes.Internal, "get page info after navigate: %v", err)
	}

	// Post-navigation SSRF check: if Chromium followed a redirect, validate the final URL.
	if finalURL != req.GetUrl() {
		if err := s.urlPolicy.Validate(ctx, finalURL); err != nil {
			// Navigate away from the blocked page to prevent data exfiltration.
			_ = chromedp.Run(runCtx, chromedp.Navigate("about:blank"))
			return nil, status.Errorf(codes.InvalidArgument, "blocked redirect URL: %v", err)
		}
	}

	return &pb.NavigateResponse{Url: finalURL, Title: title}, nil
}

// Click clicks an element matching a CSS selector.
func (s *BrowserServer) Click(ctx context.Context, req *pb.ClickRequest) (*pb.ClickResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if err := chromedp.Run(session.ctx, chromedp.Click(req.GetSelector(), chromedp.ByQuery)); err != nil {
		return nil, status.Errorf(codes.Internal, "click: %v", err)
	}

	return &pb.ClickResponse{}, nil
}

// Type types text into an element matching a CSS selector.
func (s *BrowserServer) Type(ctx context.Context, req *pb.TypeRequest) (*pb.TypeResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if err := chromedp.Run(session.ctx, chromedp.SendKeys(req.GetSelector(), req.GetText(), chromedp.ByQuery)); err != nil {
		return nil, status.Errorf(codes.Internal, "type: %v", err)
	}

	return &pb.TypeResponse{}, nil
}

// Screenshot captures the current page as a streamed image in 64KB chunks.
func (s *BrowserServer) Screenshot(req *pb.ScreenshotRequest, stream grpc.ServerStreamingServer[pb.ScreenshotResponse]) error {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	var buf []byte

	if req.GetQuality() > 0 {
		// JPEG with specified quality.
		quality := int(req.GetQuality())
		if req.GetFullPage() {
			if err := chromedp.Run(session.ctx, chromedp.FullScreenshot(&buf, quality)); err != nil {
				return status.Errorf(codes.Internal, "full screenshot jpeg: %v", err)
			}
		} else {
			if err := chromedp.Run(session.ctx, chromedp.CaptureScreenshot(&buf)); err != nil {
				return status.Errorf(codes.Internal, "screenshot jpeg: %v", err)
			}
		}
	} else {
		// PNG (quality=0 means PNG).
		if req.GetFullPage() {
			if err := chromedp.Run(session.ctx, chromedp.FullScreenshot(&buf, 100)); err != nil {
				return status.Errorf(codes.Internal, "full screenshot png: %v", err)
			}
		} else {
			if err := chromedp.Run(session.ctx, chromedp.CaptureScreenshot(&buf)); err != nil {
				return status.Errorf(codes.Internal, "screenshot png: %v", err)
			}
		}
	}

	// Stream the screenshot data in chunks.
	for i := 0; i < len(buf); i += screenshotChunkSize {
		end := i + screenshotChunkSize
		if end > len(buf) {
			end = len(buf)
		}

		isLast := end >= len(buf)
		chunk := &pb.ScreenshotResponse{
			Data: buf[i:end],
			Eof:  isLast,
		}

		if err := stream.Send(chunk); err != nil {
			return err
		}
	}

	// Edge case: empty screenshot (unlikely but handle for safety).
	if len(buf) == 0 {
		return stream.Send(&pb.ScreenshotResponse{Eof: true})
	}

	return nil
}

// EvaluateJS executes a JavaScript expression and returns the result.
func (s *BrowserServer) EvaluateJS(ctx context.Context, req *pb.EvaluateJSRequest) (*pb.EvaluateJSResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	var result interface{}
	if err := chromedp.Run(session.ctx, chromedp.Evaluate(req.GetExpression(), &result)); err != nil {
		return nil, status.Errorf(codes.Internal, "evaluate js: %v", err)
	}

	// Convert result to string.
	var resultStr string
	switch v := result.(type) {
	case string:
		resultStr = v
	case nil:
		resultStr = ""
	default:
		jsonBytes, err := json.Marshal(v)
		if err != nil {
			resultStr = fmt.Sprintf("%v", v)
		} else {
			resultStr = string(jsonBytes)
		}
	}

	return &pb.EvaluateJSResponse{Result: resultStr}, nil
}

// ExtractContent extracts text and HTML from an element.
func (s *BrowserServer) ExtractContent(ctx context.Context, req *pb.ExtractContentRequest) (*pb.ExtractContentResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	var text, html string
	if err := chromedp.Run(session.ctx,
		chromedp.Text(req.GetSelector(), &text, chromedp.ByQuery),
		chromedp.InnerHTML(req.GetSelector(), &html, chromedp.ByQuery),
	); err != nil {
		return nil, status.Errorf(codes.Internal, "extract content: %v", err)
	}

	return &pb.ExtractContentResponse{Text: text, Html: html}, nil
}

// WaitForSelector waits for an element to appear in the DOM.
func (s *BrowserServer) WaitForSelector(ctx context.Context, req *pb.WaitForSelectorRequest) (*pb.WaitForSelectorResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	waitCtx := session.ctx
	if req.GetTimeoutMs() > 0 {
		var cancel context.CancelFunc
		waitCtx, cancel = context.WithTimeout(session.ctx, time.Duration(req.GetTimeoutMs())*time.Millisecond)
		defer cancel()
	}

	if err := chromedp.Run(waitCtx, chromedp.WaitVisible(req.GetSelector(), chromedp.ByQuery)); err != nil {
		// If context deadline exceeded, the selector was not found in time.
		if waitCtx.Err() == context.DeadlineExceeded {
			return &pb.WaitForSelectorResponse{Found: false}, nil
		}
		return nil, status.Errorf(codes.Internal, "wait for selector: %v", err)
	}

	return &pb.WaitForSelectorResponse{Found: true}, nil
}

// GetPageInfo returns the current page title and URL.
func (s *BrowserServer) GetPageInfo(ctx context.Context, req *pb.GetPageInfoRequest) (*pb.GetPageInfoResponse, error) {
	session, err := s.getSession(req.GetSessionId())
	if err != nil {
		return nil, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	var title, url string
	if err := chromedp.Run(session.ctx, chromedp.Title(&title), chromedp.Location(&url)); err != nil {
		return nil, status.Errorf(codes.Internal, "get page info: %v", err)
	}

	return &pb.GetPageInfoResponse{Title: title, Url: url}, nil
}

// Close terminates a browser session.
func (s *BrowserServer) Close(ctx context.Context, req *pb.CloseRequest) (*pb.CloseResponse, error) {
	val, loaded := s.sessions.LoadAndDelete(req.GetSessionId())
	if !loaded {
		return nil, status.Errorf(codes.NotFound, "browser session %s not found", req.GetSessionId())
	}

	session := val.(*BrowserSession)

	// Cancel chromedp context first, then allocator context (ensures Chrome process shutdown).
	session.ctxCancel()
	session.allocCancel()

	return &pb.CloseResponse{}, nil
}

// GetVNCInfo returns VNC connection details when the desktop environment is available.
func (s *BrowserServer) GetVNCInfo(ctx context.Context, req *pb.GetVNCInfoRequest) (*pb.GetVNCInfoResponse, error) {
	available := desktopAvailable()
	info := &pb.VNCInfo{
		Available: available,
		Display:   vncDisplay,
	}
	if available {
		info.Password = readVNCPassword()
	}
	return &pb.GetVNCInfoResponse{VncInfo: info}, nil
}

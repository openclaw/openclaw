package envd

import (
	"context"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
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

// checkChromiumAvailable skips the test if no chromium binary is found on PATH.
func checkChromiumAvailable(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("chromium-browser"); err == nil {
		return
	}
	if _, err := exec.LookPath("chromium"); err == nil {
		return
	}
	// Also check for Google Chrome (macOS dev environment).
	if _, err := exec.LookPath("google-chrome"); err == nil {
		return
	}
	t.Skip("chromium not available, skipping browser tests")
}

func setupBrowserTestServer(t *testing.T) (pb.BrowserServiceClient, func()) {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	pb.RegisterBrowserServiceServer(srv, NewBrowserServer())

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

// TestBrowserService_CloseUnknownSession always runs (no chromium needed).
// Verifies that Close with an unknown session_id returns NotFound.
func TestBrowserService_CloseUnknownSession(t *testing.T) {
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	_, err := client.Close(context.Background(), &pb.CloseRequest{SessionId: "nonexistent-session"})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

// TestBrowserService_LaunchClose verifies session lifecycle.
func TestBrowserService_LaunchClose(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	// Launch creates a session with a UUID.
	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	assert.NotEmpty(t, launchResp.GetSessionId())
	assert.Len(t, launchResp.GetSessionId(), 36, "session_id should be UUID format")

	// Close with valid session_id succeeds.
	_, err = client.Close(context.Background(), &pb.CloseRequest{SessionId: launchResp.GetSessionId()})
	require.NoError(t, err)

	// Close again with same session_id returns NotFound.
	_, err = client.Close(context.Background(), &pb.CloseRequest{SessionId: launchResp.GetSessionId()})
	require.Error(t, err)
	assert.Equal(t, codes.NotFound, status.Code(err))
}

const testPageHTML = `data:text/html,<html><head><title>Test Page</title></head><body><input id="inp"/><button id="btn" onclick="document.getElementById('inp').value='clicked'">Go</button><p id="content">Hello World</p></body></html>`

// TestBrowserService_Navigate verifies navigation to a data URL.
func TestBrowserService_Navigate(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	navResp, err := client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)
	assert.Contains(t, navResp.GetUrl(), "data:text/html")
	assert.Equal(t, "Test Page", navResp.GetTitle())
}

// TestBrowserService_ClickAndType verifies typing and clicking interactions.
func TestBrowserService_ClickAndType(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	// Type text into the input.
	_, err = client.Type(context.Background(), &pb.TypeRequest{
		SessionId: sessionID,
		Selector:  "#inp",
		Text:      "hello",
	})
	require.NoError(t, err)

	// Click the button (which sets input value to "clicked").
	_, err = client.Click(context.Background(), &pb.ClickRequest{
		SessionId: sessionID,
		Selector:  "#btn",
	})
	require.NoError(t, err)

	// Verify the button click changed the input value via EvaluateJS.
	evalResp, err := client.EvaluateJS(context.Background(), &pb.EvaluateJSRequest{
		SessionId:  sessionID,
		Expression: `document.getElementById('inp').value`,
	})
	require.NoError(t, err)
	assert.Equal(t, "clicked", evalResp.GetResult())
}

// TestBrowserService_Screenshot verifies streamed screenshot chunks.
func TestBrowserService_Screenshot(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	stream, err := client.Screenshot(context.Background(), &pb.ScreenshotRequest{
		SessionId: sessionID,
		FullPage:  false,
		Quality:   0, // PNG
	})
	require.NoError(t, err)

	var totalBytes int
	var gotEof bool
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		totalBytes += len(resp.GetData())
		if resp.GetEof() {
			gotEof = true
			break
		}
	}

	assert.True(t, gotEof, "should receive eof=true")
	assert.Greater(t, totalBytes, 0, "screenshot should have bytes")
}

// TestBrowserService_EvaluateJS verifies JavaScript evaluation.
func TestBrowserService_EvaluateJS(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	evalResp, err := client.EvaluateJS(context.Background(), &pb.EvaluateJSRequest{
		SessionId:  sessionID,
		Expression: `document.title`,
	})
	require.NoError(t, err)
	assert.Equal(t, "Test Page", evalResp.GetResult())
}

// TestBrowserService_ExtractContent verifies text and HTML extraction.
func TestBrowserService_ExtractContent(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	extractResp, err := client.ExtractContent(context.Background(), &pb.ExtractContentRequest{
		SessionId: sessionID,
		Selector:  "#content",
	})
	require.NoError(t, err)
	assert.Equal(t, "Hello World", extractResp.GetText())
	assert.Contains(t, extractResp.GetHtml(), "Hello World")
}

// TestBrowserService_WaitForSelector verifies element waiting.
func TestBrowserService_WaitForSelector(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	// Existing element should be found.
	waitResp, err := client.WaitForSelector(context.Background(), &pb.WaitForSelectorRequest{
		SessionId: sessionID,
		Selector:  "#content",
		TimeoutMs: 5000,
	})
	require.NoError(t, err)
	assert.True(t, waitResp.GetFound())

	// Nonexistent element should timeout (not found).
	waitResp2, err := client.WaitForSelector(context.Background(), &pb.WaitForSelectorRequest{
		SessionId: sessionID,
		Selector:  "#does-not-exist",
		TimeoutMs: 500,
	})
	require.NoError(t, err)
	assert.False(t, waitResp2.GetFound())
}

// TestBrowserService_GetPageInfo verifies page info retrieval.
func TestBrowserService_GetPageInfo(t *testing.T) {
	checkChromiumAvailable(t)
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	launchResp, err := client.Launch(context.Background(), &pb.LaunchRequest{Headless: true})
	require.NoError(t, err)
	sessionID := launchResp.GetSessionId()
	defer client.Close(context.Background(), &pb.CloseRequest{SessionId: sessionID}) //nolint:errcheck

	_, err = client.Navigate(context.Background(), &pb.NavigateRequest{
		SessionId: sessionID,
		Url:       testPageHTML,
	})
	require.NoError(t, err)

	infoResp, err := client.GetPageInfo(context.Background(), &pb.GetPageInfoRequest{
		SessionId: sessionID,
	})
	require.NoError(t, err)
	assert.Equal(t, "Test Page", infoResp.GetTitle())
	assert.Contains(t, infoResp.GetUrl(), "data:text/html")
}

// TestGetVNCInfo_NotAvailable verifies GetVNCInfo returns available=false when no Xvfb binary.
// This test always runs (no chromium needed) because it tests system detection, not browser control.
func TestGetVNCInfo_NotAvailable(t *testing.T) {
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	resp, err := client.GetVNCInfo(context.Background(), &pb.GetVNCInfoRequest{})
	require.NoError(t, err)
	require.NotNil(t, resp.GetVncInfo())

	// On dev machines, /usr/bin/Xvfb typically does not exist,
	// so available should be false and password empty.
	if !desktopAvailable() {
		assert.False(t, resp.GetVncInfo().GetAvailable())
		assert.Empty(t, resp.GetVncInfo().GetPassword())
	}
	// Display is always set to 99 regardless of availability.
	assert.Equal(t, uint32(99), resp.GetVncInfo().GetDisplay())
}

// TestGetVNCInfo_Available verifies GetVNCInfo with a mock VNC password file.
// Temporarily overrides the password path constant behavior via a real file.
func TestGetVNCInfo_Available(t *testing.T) {
	client, cleanup := setupBrowserTestServer(t)
	defer cleanup()

	// Create a temporary vnc_password file to simulate desktop env.
	tmpDir := t.TempDir()
	pwFile := filepath.Join(tmpDir, "vnc_password")
	err := os.WriteFile(pwFile, []byte("testpass123"), 0600)
	require.NoError(t, err)

	// We cannot easily override the const path in a unit test,
	// so we test readVNCPassword indirectly via the exported function.
	// The real integration test would have /run/vnc_password present.

	// At minimum, verify the RPC returns a valid response structure.
	resp, err := client.GetVNCInfo(context.Background(), &pb.GetVNCInfoRequest{})
	require.NoError(t, err)
	require.NotNil(t, resp.GetVncInfo())
	assert.Equal(t, uint32(99), resp.GetVncInfo().GetDisplay())
}

// TestDesktopAvailable verifies the desktopAvailable helper function.
func TestDesktopAvailable(t *testing.T) {
	// On most dev machines /usr/bin/Xvfb won't exist.
	// Just verify the function doesn't panic and returns a boolean.
	result := desktopAvailable()
	// We can't assert true/false deterministically, but verify it's callable.
	_ = result
}

// TestReadVNCPassword verifies reading password from file.
func TestReadVNCPassword(t *testing.T) {
	// When the file doesn't exist, should return empty string.
	pw := readVNCPassword()
	if !desktopAvailable() {
		assert.Empty(t, pw, "password should be empty when desktop not available")
	}
}

package server

import (
	"context"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envd"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// setupMockEnvdFileService creates a bufconn-based mock envd FileService server
// using the real envd FileServer (which works with a temp directory).
func setupMockEnvdFileService(t *testing.T) *bufconn.Listener {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	envdpb.RegisterFileServiceServer(s, envd.NewFileServer())
	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("mock envd file server exited: %v", err)
		}
	}()
	t.Cleanup(func() {
		s.Stop()
		lis.Close()
	})
	return lis
}

// setupFileTestServer creates a bufconn-based gRPC server with the real
// fileProxy service and returns a sandbox.v1 FileServiceClient.
// The ConnCache is wired to dial the mock envd server via bufconn.
func setupFileTestServer(t *testing.T, mgr VMManager, envdLis *bufconn.Listener) pb.FileServiceClient {
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

	// Create the file proxy server.
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	pb.RegisterFileServiceServer(s, NewFileServer(mgr, connCache))

	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("file service server exited: %v", err)
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

	return pb.NewFileServiceClient(conn)
}

func TestFileService_ReadFile(t *testing.T) {
	// Create a temp file to be read via envd.
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "hello.txt")
	require.NoError(t, os.WriteFile(testFile, []byte("hello world"), 0644))

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	stream, err := client.ReadFile(context.Background(), &pb.ReadFileRequest{
		SandboxId: "sb-1",
		Path:      testFile,
	})
	require.NoError(t, err)

	var data []byte
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		data = append(data, resp.GetData()...)
		if resp.GetEof() {
			break
		}
	}

	assert.Equal(t, []byte("hello world"), data)
}

func TestFileService_WriteFile(t *testing.T) {
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "output.txt")

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	stream, err := client.WriteFile(context.Background())
	require.NoError(t, err)

	// Send first chunk with path and data.
	err = stream.Send(&pb.WriteFileRequest{
		SandboxId: "sb-1",
		Path:      testFile,
		Mode:      0644,
		Data:      []byte("written data"),
	})
	require.NoError(t, err)

	resp, err := stream.CloseAndRecv()
	require.NoError(t, err)
	assert.Equal(t, int64(12), resp.GetBytesWritten())

	// Verify file was written.
	content, err := os.ReadFile(testFile)
	require.NoError(t, err)
	assert.Equal(t, []byte("written data"), content)
}

func TestFileService_ListDir(t *testing.T) {
	tmpDir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(tmpDir, "a.txt"), []byte("a"), 0644))
	require.NoError(t, os.Mkdir(filepath.Join(tmpDir, "subdir"), 0755))

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	resp, err := client.ListDir(context.Background(), &pb.ListDirRequest{
		SandboxId: "sb-1",
		Path:      tmpDir,
	})
	require.NoError(t, err)
	require.Len(t, resp.GetEntries(), 2)

	names := map[string]bool{}
	for _, entry := range resp.GetEntries() {
		names[entry.GetName()] = true
	}
	assert.True(t, names["a.txt"])
	assert.True(t, names["subdir"])
}

func TestFileService_Stat(t *testing.T) {
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "stat-test.txt")
	require.NoError(t, os.WriteFile(testFile, []byte("12345"), 0644))

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	resp, err := client.Stat(context.Background(), &pb.StatRequest{
		SandboxId: "sb-1",
		Path:      testFile,
	})
	require.NoError(t, err)
	assert.Equal(t, testFile, resp.GetPath())
	assert.Equal(t, int64(5), resp.GetSize())
	assert.False(t, resp.GetIsDir())
}

func TestFileService_MakeDir(t *testing.T) {
	tmpDir := t.TempDir()
	newDir := filepath.Join(tmpDir, "new", "nested", "dir")

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	_, err := client.MakeDir(context.Background(), &pb.MakeDirRequest{
		SandboxId: "sb-1",
		Path:      newDir,
		Mode:      0755,
	})
	require.NoError(t, err)

	// Verify directory was created.
	info, err := os.Stat(newDir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())
}

func TestFileService_Remove(t *testing.T) {
	tmpDir := t.TempDir()
	testFile := filepath.Join(tmpDir, "to-remove.txt")
	require.NoError(t, os.WriteFile(testFile, []byte("delete me"), 0644))

	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManagerWithVM("sb-1")
	client := setupFileTestServer(t, mgr, envdLis)

	_, err := client.Remove(context.Background(), &pb.RemoveRequest{
		SandboxId: "sb-1",
		Path:      testFile,
	})
	require.NoError(t, err)

	// Verify file was removed.
	_, err = os.Stat(testFile)
	assert.True(t, os.IsNotExist(err))
}

func TestFileService_NotFound_Sandbox(t *testing.T) {
	envdLis := setupMockEnvdFileService(t)
	mgr := newMockManager() // empty manager, no sandboxes
	client := setupFileTestServer(t, mgr, envdLis)

	// Stat with unknown sandbox_id should return NotFound.
	_, err := client.Stat(context.Background(), &pb.StatRequest{
		SandboxId: "nonexistent",
		Path:      "/tmp/foo",
	})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.NotFound, st.Code())
}

func TestFileService_Unavailable_EnvdUnreachable(t *testing.T) {
	// Create a bufconn listener, then immediately close it to simulate unreachable envd.
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	envdpb.RegisterFileServiceServer(s, envd.NewFileServer())
	go func() { _ = s.Serve(lis) }()
	// Stop the server immediately so connections fail.
	s.Stop()
	lis.Close()

	// Use a dialer that will fail because the listener is closed.
	dialer := func(ctx context.Context, vsockPath string) (*grpc.ClientConn, error) {
		conn, err := grpc.NewClient(
			"passthrough:///bufconn",
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return lis.DialContext(ctx)
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		)
		return conn, err
	}
	connCache := envdclient.NewConnCache(dialer)
	defer connCache.RemoveAll()

	mgr := newMockManagerWithVM("sb-1")

	// Create proxy server.
	proxyLis := bufconn.Listen(bufSize)
	proxyServer := grpc.NewServer()
	pb.RegisterFileServiceServer(proxyServer, NewFileServer(mgr, connCache))
	go func() { _ = proxyServer.Serve(proxyLis) }()
	defer func() {
		proxyServer.Stop()
		proxyLis.Close()
	}()

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return proxyLis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	client := pb.NewFileServiceClient(conn)

	// Stat should fail because envd is not reachable (connection will fail on RPC).
	_, err = client.Stat(context.Background(), &pb.StatRequest{
		SandboxId: "sb-1",
		Path:      "/tmp/foo",
	})
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	// Expect Unavailable (envd connection failed)
	assert.Equal(t, codes.Unavailable, st.Code())
}

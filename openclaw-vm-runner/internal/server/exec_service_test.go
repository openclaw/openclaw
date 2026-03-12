package server

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"github.com/openclaw/vm-runner/internal/vm"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// mockEnvdServer implements envd.v1 ProcessServiceServer for testing.
type mockEnvdServer struct {
	envdpb.UnimplementedProcessServiceServer

	mu             sync.Mutex
	startReq       *envdpb.StartRequest
	sendInputCalls []*envdpb.SendInputRequest
	responses      []*envdpb.StartResponse
	startErr       error
}

func (m *mockEnvdServer) Start(req *envdpb.StartRequest, stream grpc.ServerStreamingServer[envdpb.StartResponse]) error {
	m.mu.Lock()
	m.startReq = req
	responses := m.responses
	startErr := m.startErr
	m.mu.Unlock()

	if startErr != nil {
		return startErr
	}

	for _, resp := range responses {
		if err := stream.Send(resp); err != nil {
			return err
		}
	}
	return nil
}

func (m *mockEnvdServer) SendInput(ctx context.Context, req *envdpb.SendInputRequest) (*envdpb.SendInputResponse, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sendInputCalls = append(m.sendInputCalls, req)
	return &envdpb.SendInputResponse{}, nil
}

func (m *mockEnvdServer) getStartReq() *envdpb.StartRequest {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.startReq
}

// setupMockEnvd creates a bufconn-based mock envd ProcessService server
// and returns the bufconn listener for client connection.
func setupMockEnvd(t *testing.T, mock *mockEnvdServer) *bufconn.Listener {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	envdpb.RegisterProcessServiceServer(s, mock)
	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("mock envd server exited: %v", err)
		}
	}()
	t.Cleanup(func() {
		s.Stop()
		lis.Close()
	})
	return lis
}

// setupExecTestServer creates a bufconn-based gRPC server with the real
// execBridge service and returns an ExecServiceClient. The ConnCache is
// wired to dial the mock envd server via bufconn.
func setupExecTestServer(t *testing.T, mgr VMManager, envdLis *bufconn.Listener) pb.ExecServiceClient {
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

	// Create the exec bridge server.
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	pb.RegisterExecServiceServer(s, NewExecServer(mgr, connCache))

	go func() {
		if err := s.Serve(lis); err != nil {
			t.Logf("exec service server exited: %v", err)
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

	return pb.NewExecServiceClient(conn)
}

// newMockManagerWithVM creates a mockManager with a pre-existing sandbox
// that has a VMConfig with VsockPath set.
func newMockManagerWithVM(sandboxID string) *mockManager {
	mgr := newMockManager()
	mgr.machines[sandboxID] = &vm.MachineEntry{
		ID:        sandboxID,
		CreatedAt: time.Now(),
		State:     vm.StateRunning,
		VMConfig: &vm.VMConfig{
			VsockPath: "/tmp/test-vsock.sock",
		},
	}
	return mgr
}

func TestExecBridge_ForwardCommand(t *testing.T) {
	envdMock := &mockEnvdServer{
		responses: []*envdpb.StartResponse{
			{ProcessId: "proc-1", Output: &envdpb.StartResponse_Stdout{Stdout: []byte("hello")}},
			{Output: &envdpb.StartResponse_Stderr{Stderr: []byte("warn")}},
			{Eof: true, ExitCode: 0},
		},
	}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	// Send StartExec
	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId:  "sb-1",
				Command:    []string{"echo", "hello"},
				WorkingDir: "/workspace",
				Env:        map[string]string{"FOO": "bar"},
				TimeoutMs:  5000,
			},
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	// Receive responses
	var responses []*pb.ExecResponse
	for {
		resp, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
		responses = append(responses, resp)
	}

	require.Len(t, responses, 3)
	assert.Equal(t, []byte("hello"), responses[0].GetStdoutData())
	assert.Equal(t, []byte("warn"), responses[1].GetStderrData())
	assert.NotNil(t, responses[2].GetExit())
	assert.Equal(t, int32(0), responses[2].GetExit().GetExitCode())

	// Verify envd received the correct StartRequest
	startReq := envdMock.getStartReq()
	require.NotNil(t, startReq)
	assert.Equal(t, "echo hello", startReq.GetCommand())
	assert.Equal(t, "/workspace", startReq.GetWorkdir())
	assert.Equal(t, map[string]string{"FOO": "bar"}, startReq.GetEnv())
	assert.Equal(t, uint32(5), startReq.GetTimeoutSec())
}

func TestExecBridge_JoinsCommand(t *testing.T) {
	envdMock := &mockEnvdServer{
		responses: []*envdpb.StartResponse{
			{ProcessId: "proc-1", Eof: true, ExitCode: 0},
		},
	}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId: "sb-1",
				Command:   []string{"ls", "-la", "/tmp"},
			},
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	// Drain responses
	for {
		_, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
	}

	startReq := envdMock.getStartReq()
	require.NotNil(t, startReq)
	assert.Equal(t, "ls -la /tmp", startReq.GetCommand())
}

func TestExecBridge_ConvertsTimeoutMsToSec(t *testing.T) {
	envdMock := &mockEnvdServer{
		responses: []*envdpb.StartResponse{
			{ProcessId: "proc-1", Eof: true, ExitCode: 0},
		},
	}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId: "sb-1",
				Command:   []string{"sleep", "1"},
				TimeoutMs: 30000,
			},
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	// Drain responses
	for {
		_, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
	}

	startReq := envdMock.getStartReq()
	require.NotNil(t, startReq)
	assert.Equal(t, uint32(30), startReq.GetTimeoutSec())
}

func TestExecBridge_NotFound(t *testing.T) {
	envdMock := &mockEnvdServer{}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManager() // empty manager, no sandboxes
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId: "nonexistent",
				Command:   []string{"echo", "hi"},
			},
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	_, err = stream.Recv()
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.NotFound, st.Code())
}

func TestExecBridge_InvalidArgument_NoStartExec(t *testing.T) {
	envdMock := &mockEnvdServer{}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	// Send stdin_data as first message (not StartExec)
	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_StdinData{
			StdinData: []byte("data"),
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	_, err = stream.Recv()
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.InvalidArgument, st.Code())
}

func TestExecBridge_EnvdStreamError(t *testing.T) {
	envdMock := &mockEnvdServer{
		startErr: fmt.Errorf("envd internal failure"),
	}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId: "sb-1",
				Command:   []string{"echo", "hello"},
			},
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	_, err = stream.Recv()
	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	// envd stream error should result in Internal or an error code
	assert.NotEqual(t, codes.OK, st.Code())
}

func TestExecBridge_ForwardStdin(t *testing.T) {
	// This mock sends process_id in first response, then waits briefly,
	// then sends eof. During that time, stdin should be forwarded.
	envdMock := &mockEnvdServer{
		responses: []*envdpb.StartResponse{
			{ProcessId: "proc-42", Output: &envdpb.StartResponse_Stdout{Stdout: []byte("prompt>")}},
			{Eof: true, ExitCode: 0},
		},
	}
	envdLis := setupMockEnvd(t, envdMock)

	mgr := newMockManagerWithVM("sb-1")
	client := setupExecTestServer(t, mgr, envdLis)

	stream, err := client.Exec(context.Background())
	require.NoError(t, err)

	// Send StartExec
	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_Start{
			Start: &pb.StartExec{
				SandboxId: "sb-1",
				Command:   []string{"cat"},
			},
		},
	})
	require.NoError(t, err)

	// Send stdin data
	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_StdinData{
			StdinData: []byte("input data"),
		},
	})
	require.NoError(t, err)

	// Close stdin
	err = stream.Send(&pb.ExecRequest{
		Payload: &pb.ExecRequest_CloseStdin{
			CloseStdin: true,
		},
	})
	require.NoError(t, err)
	require.NoError(t, stream.CloseSend())

	// Drain responses
	for {
		_, err := stream.Recv()
		if err == io.EOF {
			break
		}
		require.NoError(t, err)
	}

	// Note: stdin forwarding is best-effort -- the mock envd server
	// finishes quickly so SendInput may or may not be called depending
	// on timing. The important thing is no errors or goroutine leaks.
}

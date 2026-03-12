package envd

import (
	"context"
	"net"
	"testing"
	"time"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/test/bufconn"
)

const bufSize = 1024 * 1024

func setupProcessTestServer(t *testing.T) (pb.ProcessServiceClient, func()) {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	pb.RegisterProcessServiceServer(srv, NewProcessServer())

	go func() { _ = srv.Serve(lis) }()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)

	client := pb.NewProcessServiceClient(conn)
	cleanup := func() {
		conn.Close()
		srv.Stop()
		lis.Close()
	}
	return client, cleanup
}

func TestProcessService_StartEchoCommand(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command: "echo hello world",
		Workdir: t.TempDir(),
	})
	require.NoError(t, err)

	var processID string
	var gotStdout []byte
	var gotEof bool
	var exitCode int32

	for {
		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetProcessId() != "" {
			processID = resp.GetProcessId()
		}
		if resp.GetStdout() != nil {
			gotStdout = append(gotStdout, resp.GetStdout()...)
		}
		if resp.GetEof() {
			gotEof = true
			exitCode = resp.GetExitCode()
			break
		}
	}

	assert.NotEmpty(t, processID, "should receive process_id")
	assert.True(t, gotEof, "should receive EOF")
	assert.Equal(t, int32(0), exitCode, "exit code should be 0")
	assert.Contains(t, string(gotStdout), "hello world")
}

func TestProcessService_StartStderrOutput(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command: "echo error-msg >&2",
		Workdir: t.TempDir(),
	})
	require.NoError(t, err)

	var gotStderr []byte
	for {
		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetStderr() != nil {
			gotStderr = append(gotStderr, resp.GetStderr()...)
		}
		if resp.GetEof() {
			break
		}
	}

	assert.Contains(t, string(gotStderr), "error-msg")
}

func TestProcessService_StartExitCode(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command: "exit 42",
		Workdir: t.TempDir(),
	})
	require.NoError(t, err)

	var exitCode int32
	for {
		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetEof() {
			exitCode = resp.GetExitCode()
			break
		}
	}

	assert.Equal(t, int32(42), exitCode)
}

func TestProcessService_StartTimeout(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command:    "sleep 60",
		Workdir:    t.TempDir(),
		TimeoutSec: 1,
	})
	require.NoError(t, err)

	var timedOut bool
	var exitCode int32
	deadline := time.After(10 * time.Second)

	for {
		select {
		case <-deadline:
			t.Fatal("test timed out waiting for process timeout")
		default:
		}

		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetEof() {
			timedOut = resp.GetTimedOut()
			exitCode = resp.GetExitCode()
			break
		}
	}

	assert.True(t, timedOut, "should report timed_out=true")
	assert.Equal(t, int32(137), exitCode, "timeout exit code should be 137")
}

func TestProcessService_StartWithEnv(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command: "echo $MY_VAR",
		Workdir: t.TempDir(),
		Env:     map[string]string{"MY_VAR": "test_value_123"},
	})
	require.NoError(t, err)

	var gotStdout []byte
	for {
		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetStdout() != nil {
			gotStdout = append(gotStdout, resp.GetStdout()...)
		}
		if resp.GetEof() {
			break
		}
	}

	assert.Contains(t, string(gotStdout), "test_value_123")
}

func TestProcessService_List(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	// Start a long-running process so it's visible in List.
	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command:    "sleep 30",
		Workdir:    t.TempDir(),
		TimeoutSec: 30,
	})
	require.NoError(t, err)

	// Read the first response to get the process ID.
	resp, err := stream.Recv()
	require.NoError(t, err)
	assert.NotEmpty(t, resp.GetProcessId())

	// Give the process a moment to register.
	time.Sleep(50 * time.Millisecond)

	// List should show the running process.
	listResp, err := client.List(context.Background(), &pb.ListRequest{})
	require.NoError(t, err)
	assert.GreaterOrEqual(t, len(listResp.GetProcesses()), 1)

	found := false
	for _, p := range listResp.GetProcesses() {
		if p.GetProcessId() == resp.GetProcessId() {
			found = true
			assert.Equal(t, "sleep 30", p.GetCommand())
			assert.True(t, p.GetRunning())
		}
	}
	assert.True(t, found, "should find running process in list")
}

func TestProcessService_SendSignal(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command: "sleep 60",
		Workdir: t.TempDir(),
	})
	require.NoError(t, err)

	// Read first response to get process ID.
	resp, err := stream.Recv()
	require.NoError(t, err)
	processID := resp.GetProcessId()
	require.NotEmpty(t, processID)

	// Give process time to start.
	time.Sleep(100 * time.Millisecond)

	// Send SIGTERM (15).
	_, err = client.SendSignal(context.Background(), &pb.SendSignalRequest{
		ProcessId: processID,
		Signal:    15,
	})
	require.NoError(t, err)

	// The stream should finish with a non-zero exit code.
	var gotEof bool
	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("test timed out")
		default:
		}

		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetEof() {
			gotEof = true
			break
		}
	}

	assert.True(t, gotEof, "stream should end after signal")
}

func TestProcessService_SendSignalNotFound(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	_, err := client.SendSignal(context.Background(), &pb.SendSignalRequest{
		ProcessId: "nonexistent-id",
		Signal:    15,
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestProcessService_SendInput(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	stream, err := client.Start(context.Background(), &pb.StartRequest{
		Command:    "cat",
		Workdir:    t.TempDir(),
		TimeoutSec: 5,
	})
	require.NoError(t, err)

	// Read first response to get process ID.
	resp, err := stream.Recv()
	require.NoError(t, err)
	processID := resp.GetProcessId()
	require.NotEmpty(t, processID)

	// Give process time to start.
	time.Sleep(100 * time.Millisecond)

	// Send input data.
	_, err = client.SendInput(context.Background(), &pb.SendInputRequest{
		ProcessId: processID,
		Data:      []byte("hello from stdin\n"),
	})
	require.NoError(t, err)

	// Send signal to end the cat process.
	time.Sleep(100 * time.Millisecond)
	_, _ = client.SendSignal(context.Background(), &pb.SendSignalRequest{
		ProcessId: processID,
		Signal:    15,
	})

	// Collect stdout.
	var gotStdout []byte
	deadline := time.After(5 * time.Second)
	for {
		select {
		case <-deadline:
			t.Fatal("test timed out")
		default:
		}

		resp, err := stream.Recv()
		if err != nil {
			break
		}
		if resp.GetStdout() != nil {
			gotStdout = append(gotStdout, resp.GetStdout()...)
		}
		if resp.GetEof() {
			break
		}
	}

	assert.Contains(t, string(gotStdout), "hello from stdin")
}

func TestProcessService_SendInputNotFound(t *testing.T) {
	client, cleanup := setupProcessTestServer(t)
	defer cleanup()

	_, err := client.SendInput(context.Background(), &pb.SendInputRequest{
		ProcessId: "nonexistent-id",
		Data:      []byte("test"),
	})
	assert.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

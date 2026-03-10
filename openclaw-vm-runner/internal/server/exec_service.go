package server

import (
	"io"
	"strings"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// shellEscape wraps a single argument in single quotes, escaping any embedded
// single quotes. This prevents shell injection when arguments are concatenated
// into a single command string for sh -lc.
func shellEscape(arg string) string {
	return "'" + strings.ReplaceAll(arg, "'", "'\\''") + "'"
}

// execBridge implements ExecServiceServer by forwarding commands to the envd
// ProcessService inside a Firecracker VM via a cached vsock gRPC connection.
type execBridge struct {
	pb.UnimplementedExecServiceServer
	mgr       VMManager
	connCache *envdclient.ConnCache
}

// NewExecServer creates a new ExecService gRPC handler that bridges exec
// requests to the envd ProcessService running inside the target sandbox VM.
func NewExecServer(mgr VMManager, connCache *envdclient.ConnCache) *execBridge {
	return &execBridge{mgr: mgr, connCache: connCache}
}

// Exec implements the bidirectional streaming ExecService.Exec RPC.
// It translates the bidi client stream into a server stream call to envd
// ProcessService.Start, plus stdin forwarding via ProcessService.SendInput.
func (s *execBridge) Exec(stream pb.ExecService_ExecServer) error {
	ctx := stream.Context()

	// 1. Receive first message -- must be StartExec.
	firstMsg, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.Internal, "failed to receive first message: %v", err)
	}
	startExec := firstMsg.GetStart()
	if startExec == nil {
		return status.Errorf(codes.InvalidArgument, "first message must be StartExec")
	}

	sandboxID := startExec.GetSandboxId()

	// 2. Lookup sandbox in Manager.
	entry, err := s.mgr.Get(sandboxID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return status.Errorf(codes.NotFound, "sandbox %s not found", sandboxID)
		}
		return status.Errorf(codes.Internal, "failed to get sandbox: %v", err)
	}

	// 3. Get or dial envd connection via ConnCache.
	conn, err := s.connCache.GetOrDial(ctx, sandboxID, entry.VMConfig.VsockPath)
	if err != nil {
		return status.Errorf(codes.Unavailable, "cannot reach envd for sandbox %s: %v", sandboxID, err)
	}

	// 4. Create envd ProcessService client.
	envdClient := envdpb.NewProcessServiceClient(conn)

	// 5. Convert command: shell-escape each argument before joining to prevent injection.
	rawArgs := startExec.GetCommand()
	escapedArgs := make([]string, len(rawArgs))
	for i, arg := range rawArgs {
		escapedArgs[i] = shellEscape(arg)
	}
	shellCmd := strings.Join(escapedArgs, " ")

	// 6. Convert timeout: ms -> sec.
	timeoutSec := startExec.GetTimeoutMs() / 1000

	// 7. Call envd Start with server stream.
	envdStream, err := envdClient.Start(ctx, &envdpb.StartRequest{
		Command:    shellCmd,
		Workdir:    startExec.GetWorkingDir(),
		Env:        startExec.GetEnv(),
		TimeoutSec: timeoutSec,
	})
	if err != nil {
		return status.Errorf(codes.Unavailable, "failed to start command on envd: %v", err)
	}

	// 8. Spawn stdin forwarder goroutine.
	// processID comes from the first envd response, communicated via channel.
	pidCh := make(chan string, 1)
	go s.forwardStdin(stream, envdClient, pidCh)

	// 9. Forward envd responses to client.
	for {
		resp, err := envdStream.Recv()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return status.Errorf(codes.Internal, "envd stream error: %v", err)
		}

		// Send process_id to stdin forwarder on first response.
		if pid := resp.GetProcessId(); pid != "" {
			select {
			case pidCh <- pid:
			default:
			}
		}

		// Translate envd StartResponse -> ExecResponse.
		if stdout := resp.GetStdout(); len(stdout) > 0 {
			if err := stream.Send(&pb.ExecResponse{
				Payload: &pb.ExecResponse_StdoutData{StdoutData: stdout},
			}); err != nil {
				return err
			}
		}
		if stderr := resp.GetStderr(); len(stderr) > 0 {
			if err := stream.Send(&pb.ExecResponse{
				Payload: &pb.ExecResponse_StderrData{StderrData: stderr},
			}); err != nil {
				return err
			}
		}

		if resp.GetEof() {
			errMsg := ""
			if resp.GetTimedOut() {
				errMsg = "process timed out"
			}
			if err := stream.Send(&pb.ExecResponse{
				Payload: &pb.ExecResponse_Exit{
					Exit: &pb.ExecExit{
						ExitCode: resp.GetExitCode(),
						Error:    errMsg,
					},
				},
			}); err != nil {
				return err
			}
			return nil
		}
	}
}

// forwardStdin reads subsequent ExecRequest messages from the client stream
// and forwards stdin_data to envd via ProcessService.SendInput.
// It waits for the process_id from pidCh before sending.
// The goroutine exits when the client stream ends, close_stdin is received,
// or the stream context is cancelled.
func (s *execBridge) forwardStdin(
	stream pb.ExecService_ExecServer,
	envdClient envdpb.ProcessServiceClient,
	pidCh <-chan string,
) {
	ctx := stream.Context()

	// Wait for process_id from the envd response reader.
	var processID string
	select {
	case processID = <-pidCh:
	case <-ctx.Done():
		return
	}

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msg, err := stream.Recv()
		if err != nil {
			// Client closed the stream or error -- done.
			return
		}

		switch payload := msg.GetPayload().(type) {
		case *pb.ExecRequest_StdinData:
			_, _ = envdClient.SendInput(ctx, &envdpb.SendInputRequest{
				ProcessId: processID,
				Data:      payload.StdinData,
			})
		case *pb.ExecRequest_CloseStdin:
			return
		}
	}
}

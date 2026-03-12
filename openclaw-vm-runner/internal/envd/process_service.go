package envd

import (
	"context"
	"io"
	"os/exec"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	defaultWorkdir = "/workspace"
	defaultPath    = "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
	readBufSize    = 4096
	graceTimeout   = 5 * time.Second
)

// ProcessServer implements the ProcessService gRPC server.
type ProcessServer struct {
	pb.UnimplementedProcessServiceServer
	tracker *ProcessTracker
}

// NewProcessServer creates a new ProcessServer.
func NewProcessServer() *ProcessServer {
	return &ProcessServer{
		tracker: NewProcessTracker(),
	}
}

// Start executes a command and streams stdout/stderr back to the client.
func (s *ProcessServer) Start(req *pb.StartRequest, stream pb.ProcessService_StartServer) error {
	ctx := stream.Context()
	var cancel context.CancelFunc

	if req.GetTimeoutSec() > 0 {
		ctx, cancel = context.WithTimeout(ctx, time.Duration(req.GetTimeoutSec())*time.Second)
		defer cancel()
	}

	workdir := req.GetWorkdir()
	if workdir == "" {
		workdir = defaultWorkdir
	}

	cmd := exec.CommandContext(ctx, "sh", "-lc", req.GetCommand())
	cmd.Dir = workdir
	cmd.Env = buildEnv(req.GetEnv())
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return status.Errorf(codes.Internal, "create stdout pipe: %v", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return status.Errorf(codes.Internal, "create stderr pipe: %v", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return status.Errorf(codes.Internal, "create stdin pipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		return status.Errorf(codes.Internal, "start process: %v", err)
	}

	processID := uuid.New().String()
	procCtx, procCancel := context.WithCancel(ctx)
	tracked := &TrackedProcess{
		Cmd:       cmd,
		Stdin:     stdin,
		Pgid:      cmd.Process.Pid,
		Ctx:       procCtx,
		Cancel:    procCancel,
		ProcessID: processID,
		Command:   req.GetCommand(),
	}
	tracked.SetRunning(true)
	s.tracker.Store(processID, tracked)

	// Send initial response with process ID.
	if err := stream.Send(&pb.StartResponse{ProcessId: processID}); err != nil {
		s.cleanupProcess(tracked)
		return err
	}

	// Stream stdout and stderr concurrently with mutex-protected sends.
	var mu sync.Mutex
	var wg sync.WaitGroup
	wg.Add(2)
	go s.streamPipe(stream, stdout, true, &mu, &wg)
	go s.streamPipe(stream, stderr, false, &mu, &wg)
	wg.Wait()

	// Wait for process exit.
	waitErr := cmd.Wait()
	exitCode := int32(0)
	timedOut := false

	if waitErr != nil {
		if exitErr, ok := waitErr.(*exec.ExitError); ok {
			exitCode = int32(exitErr.ExitCode())
		}
		if ctx.Err() == context.DeadlineExceeded {
			timedOut = true
			exitCode = 137
			// Ensure the entire process group is killed.
			_ = syscall.Kill(-tracked.Pgid, syscall.SIGKILL)
		}
	}

	// Send final EOF message.
	mu.Lock()
	sendErr := stream.Send(&pb.StartResponse{
		Eof:      true,
		ExitCode: exitCode,
		TimedOut: timedOut,
	})
	mu.Unlock()

	tracked.SetRunning(false)
	s.tracker.Delete(processID)
	procCancel()

	return sendErr
}

// SendInput writes data to a tracked process's stdin.
func (s *ProcessServer) SendInput(ctx context.Context, req *pb.SendInputRequest) (*pb.SendInputResponse, error) {
	proc, ok := s.tracker.Load(req.GetProcessId())
	if !ok {
		return nil, status.Errorf(codes.NotFound, "process %s not found", req.GetProcessId())
	}

	proc.mu.Lock()
	defer proc.mu.Unlock()

	if proc.Stdin == nil {
		return nil, status.Errorf(codes.FailedPrecondition, "stdin closed for process %s", req.GetProcessId())
	}

	if _, err := proc.Stdin.Write(req.GetData()); err != nil {
		return nil, status.Errorf(codes.Internal, "write to stdin: %v", err)
	}

	return &pb.SendInputResponse{}, nil
}

// SendSignal sends a signal to a tracked process group.
func (s *ProcessServer) SendSignal(ctx context.Context, req *pb.SendSignalRequest) (*pb.SendSignalResponse, error) {
	proc, ok := s.tracker.Load(req.GetProcessId())
	if !ok {
		return nil, status.Errorf(codes.NotFound, "process %s not found", req.GetProcessId())
	}

	sig := syscall.Signal(req.GetSignal())
	if err := syscall.Kill(-proc.Pgid, sig); err != nil {
		return nil, status.Errorf(codes.Internal, "send signal %d: %v", req.GetSignal(), err)
	}

	return &pb.SendSignalResponse{}, nil
}

// List returns all currently tracked processes.
func (s *ProcessServer) List(ctx context.Context, req *pb.ListRequest) (*pb.ListResponse, error) {
	procs := s.tracker.List()
	infos := make([]*pb.ProcessInfo, 0, len(procs))
	for _, p := range procs {
		running := p.IsRunning()
		infos = append(infos, &pb.ProcessInfo{
			ProcessId: p.ProcessID,
			Command:   p.Command,
			Running:   running,
		})
	}
	return &pb.ListResponse{Processes: infos}, nil
}

// streamPipe reads from a pipe and sends chunks over the gRPC stream.
func (s *ProcessServer) streamPipe(stream pb.ProcessService_StartServer, pipe io.Reader, isStdout bool, mu *sync.Mutex, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, readBufSize)
	for {
		n, err := pipe.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			var resp *pb.StartResponse
			if isStdout {
				resp = &pb.StartResponse{Output: &pb.StartResponse_Stdout{Stdout: chunk}}
			} else {
				resp = &pb.StartResponse{Output: &pb.StartResponse_Stderr{Stderr: chunk}}
			}

			mu.Lock()
			_ = stream.Send(resp)
			mu.Unlock()
		}
		if err != nil {
			break
		}
	}
}

// buildEnv creates the environment variable slice for process execution.
func buildEnv(env map[string]string) []string {
	result := []string{defaultPath}
	for k, v := range env {
		result = append(result, k+"="+v)
	}
	return result
}

// cleanupProcess kills a tracked process and removes it from the tracker.
func (s *ProcessServer) cleanupProcess(proc *TrackedProcess) {
	if proc.Cmd != nil && proc.Cmd.Process != nil {
		_ = syscall.Kill(-proc.Pgid, syscall.SIGKILL)
	}
	proc.Cancel()
	s.tracker.Delete(proc.ProcessID)
}

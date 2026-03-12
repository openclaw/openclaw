package server

import (
	"context"
	"io"
	"strings"

	envdpb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/envdclient"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// fileProxy implements FileServiceServer by forwarding all file operations
// to the envd FileService inside a Firecracker VM via a cached vsock gRPC connection.
type fileProxy struct {
	pb.UnimplementedFileServiceServer
	mgr       VMManager
	connCache *envdclient.ConnCache
}

// NewFileServer creates a new FileService gRPC handler that bridges file
// requests to the envd FileService running inside the target sandbox VM.
func NewFileServer(mgr VMManager, connCache *envdclient.ConnCache) *fileProxy {
	return &fileProxy{mgr: mgr, connCache: connCache}
}

// getEnvdFileClient resolves the sandbox_id, dials envd via ConnCache,
// and returns a FileServiceClient for the target VM.
func (s *fileProxy) getEnvdFileClient(ctx context.Context, sandboxID string) (envdpb.FileServiceClient, error) {
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

	return envdpb.NewFileServiceClient(conn), nil
}

// Stat returns metadata for a file or directory inside the sandbox.
func (s *fileProxy) Stat(ctx context.Context, req *pb.StatRequest) (*pb.StatResponse, error) {
	envdClient, err := s.getEnvdFileClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.Stat(ctx, &envdpb.StatRequest{
		Path: req.GetPath(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.StatResponse{
		Path:        resp.GetPath(),
		Size:        resp.GetSize(),
		Mode:        resp.GetMode(),
		IsDir:       resp.GetIsDir(),
		ModTimeUnix: resp.GetModTimeUnix(),
	}, nil
}

// ReadFile reads a file from the sandbox and streams its content in chunks.
func (s *fileProxy) ReadFile(req *pb.ReadFileRequest, stream grpc.ServerStreamingServer[pb.ReadFileResponse]) error {
	ctx := stream.Context()

	envdClient, err := s.getEnvdFileClient(ctx, req.GetSandboxId())
	if err != nil {
		return err
	}

	envdStream, err := envdClient.ReadFile(ctx, &envdpb.ReadFileRequest{
		Path: req.GetPath(),
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

		if err := stream.Send(&pb.ReadFileResponse{
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

// WriteFile accepts client-streamed chunks and writes them to a file in the sandbox.
// The sandbox_id is extracted from the first chunk for routing.
func (s *fileProxy) WriteFile(stream grpc.ClientStreamingServer[pb.WriteFileRequest, pb.WriteFileResponse]) error {
	ctx := stream.Context()

	// 1. Receive the first chunk to get sandbox_id and path.
	first, err := stream.Recv()
	if err != nil {
		return status.Errorf(codes.Internal, "failed to receive first chunk: %v", err)
	}

	sandboxID := first.GetSandboxId()
	envdClient, err := s.getEnvdFileClient(ctx, sandboxID)
	if err != nil {
		return err
	}

	// 2. Open a write stream to envd.
	envdStream, err := envdClient.WriteFile(ctx)
	if err != nil {
		return translateEnvdError(err, sandboxID)
	}

	// 3. Forward the first chunk (without sandbox_id -- envd doesn't need it).
	if err := envdStream.Send(&envdpb.WriteFileRequest{
		Path: first.GetPath(),
		Mode: first.GetMode(),
		Data: first.GetData(),
	}); err != nil {
		return translateEnvdError(err, sandboxID)
	}

	// 4. Forward subsequent chunks.
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return status.Errorf(codes.Internal, "failed to receive chunk: %v", err)
		}

		if err := envdStream.Send(&envdpb.WriteFileRequest{
			Path: chunk.GetPath(),
			Mode: chunk.GetMode(),
			Data: chunk.GetData(),
		}); err != nil {
			return translateEnvdError(err, sandboxID)
		}
	}

	// 5. Close and receive response from envd.
	resp, err := envdStream.CloseAndRecv()
	if err != nil {
		return translateEnvdError(err, sandboxID)
	}

	return stream.SendAndClose(&pb.WriteFileResponse{
		BytesWritten: resp.GetBytesWritten(),
	})
}

// ListDir returns directory entries from the sandbox.
func (s *fileProxy) ListDir(ctx context.Context, req *pb.ListDirRequest) (*pb.ListDirResponse, error) {
	envdClient, err := s.getEnvdFileClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	resp, err := envdClient.ListDir(ctx, &envdpb.ListDirRequest{
		Path: req.GetPath(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	entries := make([]*pb.FileInfo, 0, len(resp.GetEntries()))
	for _, e := range resp.GetEntries() {
		entries = append(entries, &pb.FileInfo{
			Name:        e.GetName(),
			Size:        e.GetSize(),
			Mode:        e.GetMode(),
			IsDir:       e.GetIsDir(),
			ModTimeUnix: e.GetModTimeUnix(),
		})
	}

	return &pb.ListDirResponse{Entries: entries}, nil
}

// MakeDir creates directories recursively inside the sandbox.
func (s *fileProxy) MakeDir(ctx context.Context, req *pb.MakeDirRequest) (*pb.MakeDirResponse, error) {
	envdClient, err := s.getEnvdFileClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	_, err = envdClient.MakeDir(ctx, &envdpb.MakeDirRequest{
		Path: req.GetPath(),
		Mode: req.GetMode(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.MakeDirResponse{}, nil
}

// Remove deletes files or directories inside the sandbox.
func (s *fileProxy) Remove(ctx context.Context, req *pb.RemoveRequest) (*pb.RemoveResponse, error) {
	envdClient, err := s.getEnvdFileClient(ctx, req.GetSandboxId())
	if err != nil {
		return nil, err
	}

	_, err = envdClient.Remove(ctx, &envdpb.RemoveRequest{
		Path:      req.GetPath(),
		Recursive: req.GetRecursive(),
	})
	if err != nil {
		return nil, translateEnvdError(err, req.GetSandboxId())
	}

	return &pb.RemoveResponse{}, nil
}

// translateEnvdError wraps envd errors into appropriate gRPC status codes.
// If the envd error is already a gRPC status, it preserves the code.
// Otherwise, it returns Unavailable (envd communication failure).
func translateEnvdError(err error, sandboxID string) error {
	if st, ok := status.FromError(err); ok {
		// Preserve the original gRPC status code from envd.
		return status.Errorf(st.Code(), "envd error for sandbox %s: %s", sandboxID, st.Message())
	}
	return status.Errorf(codes.Unavailable, "envd communication error for sandbox %s: %v", sandboxID, err)
}

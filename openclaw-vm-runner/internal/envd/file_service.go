package envd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const fileChunkSize = 65536 // 64KB

// workspaceRoot is the only directory tree that clients may access.
const workspaceRoot = "/workspace"

// resolvePath validates a user-supplied path and resolves it under workspaceRoot.
// It rejects empty paths, absolute paths, and any traversal outside the workspace.
func resolvePath(userPath string) (string, error) {
	if userPath == "" {
		return "", fmt.Errorf("path must not be empty")
	}
	if filepath.IsAbs(userPath) {
		return "", fmt.Errorf("absolute paths are not allowed: %s", userPath)
	}
	cleaned := filepath.Clean(userPath)
	full := filepath.Join(workspaceRoot, cleaned)
	// Ensure the resolved path is still under workspaceRoot.
	if !strings.HasPrefix(full, workspaceRoot+"/") && full != workspaceRoot {
		return "", fmt.Errorf("path escapes workspace: %s", userPath)
	}
	return full, nil
}

// FileServer implements the FileService gRPC server.
type FileServer struct {
	pb.UnimplementedFileServiceServer
}

// NewFileServer creates a new FileServer.
func NewFileServer() *FileServer {
	return &FileServer{}
}

// Stat returns metadata for a file or directory.
func (s *FileServer) Stat(ctx context.Context, req *pb.StatRequest) (*pb.StatResponse, error) {
	safePath, err := resolvePath(req.GetPath())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}

	info, err := os.Stat(safePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, status.Errorf(codes.NotFound, "path not found: %s", req.GetPath())
		}
		return nil, status.Errorf(codes.Internal, "stat: %v", err)
	}

	return &pb.StatResponse{
		Path:        req.GetPath(),
		Size:        info.Size(),
		Mode:        uint32(info.Mode()),
		IsDir:       info.IsDir(),
		ModTimeUnix: info.ModTime().Unix(),
	}, nil
}

// ReadFile reads a file and streams its content in 64KB chunks.
func (s *FileServer) ReadFile(req *pb.ReadFileRequest, stream grpc.ServerStreamingServer[pb.ReadFileResponse]) error {
	safePath, err := resolvePath(req.GetPath())
	if err != nil {
		return status.Errorf(codes.InvalidArgument, "%v", err)
	}

	f, err := os.Open(safePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return status.Errorf(codes.NotFound, "file not found: %s", req.GetPath())
		}
		if errors.Is(err, fs.ErrPermission) {
			return status.Errorf(codes.PermissionDenied, "permission denied: %s", req.GetPath())
		}
		return status.Errorf(codes.Internal, "open file: %v", err)
	}
	defer f.Close()

	buf := make([]byte, fileChunkSize)
	for {
		n, readErr := f.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			eof := readErr == io.EOF
			if err := stream.Send(&pb.ReadFileResponse{Data: chunk, Eof: eof}); err != nil {
				return err
			}
			if eof {
				return nil
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				// Edge case: n==0 and EOF (empty file or exact boundary).
				return stream.Send(&pb.ReadFileResponse{Eof: true})
			}
			return status.Errorf(codes.Internal, "read file: %v", readErr)
		}
	}
}

// WriteFile accepts client-streamed chunks and writes them to a file.
func (s *FileServer) WriteFile(stream grpc.ClientStreamingServer[pb.WriteFileRequest, pb.WriteFileResponse]) error {
	var (
		f            *os.File
		bytesWritten int64
		filePath     string
	)

	for {
		req, err := stream.Recv()
		if err == io.EOF {
			if f != nil {
				if closeErr := f.Close(); closeErr != nil {
					return status.Errorf(codes.Internal, "close file: %v", closeErr)
				}
			}
			return stream.SendAndClose(&pb.WriteFileResponse{BytesWritten: bytesWritten})
		}
		if err != nil {
			if f != nil {
				f.Close()
			}
			return err
		}

		// First chunk must contain the path.
		if f == nil {
			filePath = req.GetPath()
			if filePath == "" {
				return status.Error(codes.InvalidArgument, "path must be set in the first chunk")
			}

			safePath, resolveErr := resolvePath(filePath)
			if resolveErr != nil {
				return status.Errorf(codes.InvalidArgument, "%v", resolveErr)
			}

			mode := os.FileMode(req.GetMode())
			if mode == 0 {
				mode = 0644
			}

			// Create parent directories if needed.
			dir := filepath.Dir(safePath)
			if err := os.MkdirAll(dir, 0755); err != nil {
				return status.Errorf(codes.Internal, "create parent dirs: %v", err)
			}

			f, err = os.OpenFile(safePath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				if errors.Is(err, fs.ErrPermission) {
					return status.Errorf(codes.PermissionDenied, "permission denied: %s", filePath)
				}
				return status.Errorf(codes.Internal, "create file: %v", err)
			}
		}

		data := req.GetData()
		if len(data) > 0 {
			n, writeErr := f.Write(data)
			bytesWritten += int64(n)
			if writeErr != nil {
				f.Close()
				return status.Errorf(codes.Internal, "write file: %v", writeErr)
			}
		}
	}
}

// ListDir returns directory entries with metadata.
func (s *FileServer) ListDir(ctx context.Context, req *pb.ListDirRequest) (*pb.ListDirResponse, error) {
	safePath, err := resolvePath(req.GetPath())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}

	info, err := os.Stat(safePath)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, status.Errorf(codes.NotFound, "directory not found: %s", req.GetPath())
		}
		return nil, status.Errorf(codes.Internal, "stat: %v", err)
	}
	if !info.IsDir() {
		return nil, status.Errorf(codes.InvalidArgument, "not a directory: %s", req.GetPath())
	}

	entries, err := os.ReadDir(safePath)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "read dir: %v", err)
	}

	fileInfos := make([]*pb.FileInfo, 0, len(entries))
	for _, e := range entries {
		eInfo, err := e.Info()
		if err != nil {
			continue
		}
		fileInfos = append(fileInfos, &pb.FileInfo{
			Name:        e.Name(),
			Size:        eInfo.Size(),
			Mode:        uint32(eInfo.Mode()),
			IsDir:       e.IsDir(),
			ModTimeUnix: eInfo.ModTime().Unix(),
		})
	}

	return &pb.ListDirResponse{Entries: fileInfos}, nil
}

// MakeDir creates directories recursively.
func (s *FileServer) MakeDir(ctx context.Context, req *pb.MakeDirRequest) (*pb.MakeDirResponse, error) {
	safePath, err := resolvePath(req.GetPath())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}

	mode := os.FileMode(req.GetMode())
	if mode == 0 {
		mode = 0755
	}

	if err := os.MkdirAll(safePath, mode); err != nil {
		return nil, status.Errorf(codes.Internal, "mkdir: %v", err)
	}

	return &pb.MakeDirResponse{}, nil
}

// Remove deletes files or directories.
func (s *FileServer) Remove(ctx context.Context, req *pb.RemoveRequest) (*pb.RemoveResponse, error) {
	safePath, err := resolvePath(req.GetPath())
	if err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "%v", err)
	}

	if req.GetRecursive() {
		err = os.RemoveAll(safePath)
	} else {
		err = os.Remove(safePath)
	}

	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, status.Errorf(codes.NotFound, "path not found: %s", req.GetPath())
		}
		return nil, status.Errorf(codes.Internal, "remove: %v", err)
	}

	return &pb.RemoveResponse{}, nil
}

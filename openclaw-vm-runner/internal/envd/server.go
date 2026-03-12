package envd

import (
	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"google.golang.org/grpc"
)

// Server wraps a gRPC server with envd services registered.
type Server struct {
	GRPC *grpc.Server
}

// NewServer creates a gRPC server with ProcessService, FileService, HealthService, and BrowserService registered.
func NewServer() *Server {
	s := grpc.NewServer()
	pb.RegisterProcessServiceServer(s, NewProcessServer())
	pb.RegisterFileServiceServer(s, NewFileServer())
	pb.RegisterHealthServiceServer(s, NewHealthServer())
	pb.RegisterBrowserServiceServer(s, NewBrowserServer())
	return &Server{GRPC: s}
}

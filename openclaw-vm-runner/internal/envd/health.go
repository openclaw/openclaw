package envd

import (
	"context"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
)

// HealthServer implements the HealthService gRPC server.
type HealthServer struct {
	pb.UnimplementedHealthServiceServer
}

// NewHealthServer creates a new HealthServer.
func NewHealthServer() *HealthServer {
	return &HealthServer{}
}

// Check returns the current health status of the envd agent.
func (s *HealthServer) Check(ctx context.Context, req *pb.CheckRequest) (*pb.CheckResponse, error) {
	return &pb.CheckResponse{
		Status: pb.ServingStatus_SERVING_STATUS_SERVING,
	}, nil
}

// Package envdclient provides gRPC connectivity to envd agents running inside
// Firecracker MicroVMs via the host-side vsock Unix socket.
package envdclient

import (
	"context"
	"net"
	"time"

	fcvsock "github.com/firecracker-microvm/firecracker-go-sdk/vsock"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// EnvdPort is the gRPC listen port inside the MicroVM where envd runs.
const EnvdPort = uint32(50051)

// DialEnvd creates a gRPC ClientConn to the envd agent inside a Firecracker VM.
// It uses the firecracker-go-sdk vsock dialer to connect through the host-side
// Unix socket at vsockPath. Additional gRPC dial options can be appended.
func DialEnvd(ctx context.Context, vsockPath string, opts ...grpc.DialOption) (*grpc.ClientConn, error) {
	dialOpts := []grpc.DialOption{
		grpc.WithContextDialer(func(dialCtx context.Context, _ string) (net.Conn, error) {
			return fcvsock.DialContext(dialCtx, vsockPath, EnvdPort,
				fcvsock.WithDialTimeout(2*time.Second),
				fcvsock.WithRetryTimeout(10*time.Second),
				fcvsock.WithRetryInterval(200*time.Millisecond),
			)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	}
	dialOpts = append(dialOpts, opts...)

	return grpc.NewClient("passthrough:///vsock", dialOpts...)
}

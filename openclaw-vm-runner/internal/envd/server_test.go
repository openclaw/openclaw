package envd

import (
	"context"
	"net"
	"testing"

	pb "github.com/openclaw/vm-runner/gen/go/envd/v1"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

func TestServer_AllServicesRegistered(t *testing.T) {
	lis := bufconn.Listen(bufSize)
	srv := NewServer()

	go func() { _ = srv.GRPC.Serve(lis) }()
	defer srv.GRPC.Stop()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	// Verify ProcessService is accessible.
	processClient := pb.NewProcessServiceClient(conn)
	listResp, err := processClient.List(context.Background(), &pb.ListRequest{})
	require.NoError(t, err)
	assert.NotNil(t, listResp)

	// Verify FileService is accessible.
	fileClient := pb.NewFileServiceClient(conn)
	_, statErr := fileClient.Stat(context.Background(), &pb.StatRequest{Path: t.TempDir()})
	require.NoError(t, statErr)

	// Verify HealthService is accessible.
	healthClient := pb.NewHealthServiceClient(conn)
	healthResp, err := healthClient.Check(context.Background(), &pb.CheckRequest{})
	require.NoError(t, err)
	assert.Equal(t, pb.ServingStatus_SERVING_STATUS_SERVING, healthResp.GetStatus())

	// Verify BrowserService is accessible.
	// Close with nonexistent session should return NotFound (not Unimplemented).
	// Getting Unimplemented would mean the service is not registered.
	browserClient := pb.NewBrowserServiceClient(conn)
	_, closeErr := browserClient.Close(context.Background(), &pb.CloseRequest{SessionId: "nonexistent"})
	assert.Equal(t, codes.NotFound, status.Code(closeErr),
		"BrowserService should be registered (got Unimplemented means not registered)")
}

func TestHealthServer_Check(t *testing.T) {
	lis := bufconn.Listen(bufSize)
	srv := grpc.NewServer()
	pb.RegisterHealthServiceServer(srv, NewHealthServer())

	go func() { _ = srv.Serve(lis) }()
	defer srv.Stop()

	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return lis.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	defer conn.Close()

	client := pb.NewHealthServiceClient(conn)
	resp, err := client.Check(context.Background(), &pb.CheckRequest{})
	require.NoError(t, err)
	assert.Equal(t, pb.ServingStatus_SERVING_STATUS_SERVING, resp.GetStatus())
}

package server

import (
	"context"
	"fmt"
	"net"
	"testing"
	"time"

	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/vm"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

const bufSize = 1024 * 1024

// mockManager implements the VMManager interface for testing.
type mockManager struct {
	machines  map[string]*vm.MachineEntry
	createErr error
}

func newMockManager() *mockManager {
	return &mockManager{
		machines: make(map[string]*vm.MachineEntry),
	}
}

func (m *mockManager) Create(ctx context.Context, req *vm.CreateRequest) (*vm.MachineEntry, error) {
	if m.createErr != nil {
		return nil, m.createErr
	}
	if _, exists := m.machines[req.SandboxID]; exists {
		return nil, fmt.Errorf("sandbox %s already exists", req.SandboxID)
	}
	entry := &vm.MachineEntry{
		ID:        req.SandboxID,
		CreatedAt: time.Now(),
		State:     vm.StateRunning,
	}
	m.machines[req.SandboxID] = entry
	return entry, nil
}

func (m *mockManager) Destroy(ctx context.Context, sandboxID string) error {
	if _, exists := m.machines[sandboxID]; !exists {
		return fmt.Errorf("sandbox %s not found", sandboxID)
	}
	delete(m.machines, sandboxID)
	return nil
}

func (m *mockManager) Get(sandboxID string) (*vm.MachineEntry, error) {
	entry, exists := m.machines[sandboxID]
	if !exists {
		return nil, fmt.Errorf("sandbox %s not found", sandboxID)
	}
	return entry, nil
}

func (m *mockManager) List() []*vm.MachineEntry {
	entries := make([]*vm.MachineEntry, 0, len(m.machines))
	for _, entry := range m.machines {
		entries = append(entries, entry)
	}
	return entries
}

// setupTestServer creates a bufconn-based gRPC server with the SandboxService
// and returns a client connection for testing.
func setupTestServer(t *testing.T, mgr VMManager) pb.SandboxServiceClient {
	t.Helper()
	lis := bufconn.Listen(bufSize)
	s := grpc.NewServer()
	pb.RegisterSandboxServiceServer(s, NewSandboxServer(mgr))

	go func() {
		if err := s.Serve(lis); err != nil {
			// Only log if server wasn't stopped intentionally
			t.Logf("bufconn server exited: %v", err)
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

	return pb.NewSandboxServiceClient(conn)
}

// --- CreateSandbox tests ---

func TestCreateSandbox_Success(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	resp, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "test-sandbox-1",
	})

	require.NoError(t, err)
	assert.Equal(t, "test-sandbox-1", resp.GetSandboxId())
	assert.Equal(t, pb.SandboxState_SANDBOX_STATE_RUNNING, resp.GetState())
	assert.NotNil(t, resp.GetCreatedAt())
}

func TestCreateSandbox_DuplicateID(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	// Create the first sandbox
	_, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "duplicate-id",
	})
	require.NoError(t, err)

	// Try to create another with the same ID
	_, err = client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "duplicate-id",
	})

	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.AlreadyExists, st.Code())
}

func TestCreateSandbox_ManagerError(t *testing.T) {
	mgr := newMockManager()
	mgr.createErr = fmt.Errorf("firecracker init failed")
	client := setupTestServer(t, mgr)

	_, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "error-sandbox",
	})

	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.Internal, st.Code())
}

// --- DestroySandbox tests ---

func TestDestroySandbox_Success(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	// Create a sandbox first
	_, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "to-destroy",
	})
	require.NoError(t, err)

	// Destroy it
	_, err = client.DestroySandbox(context.Background(), &pb.DestroySandboxRequest{
		SandboxId: "to-destroy",
	})
	require.NoError(t, err)
}

func TestDestroySandbox_NotFound(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	_, err := client.DestroySandbox(context.Background(), &pb.DestroySandboxRequest{
		SandboxId: "nonexistent",
	})

	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.NotFound, st.Code())
}

// --- SandboxStatus tests ---

func TestSandboxStatus_Success(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	// Create a sandbox first
	_, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "status-test",
	})
	require.NoError(t, err)

	resp, err := client.SandboxStatus(context.Background(), &pb.SandboxStatusRequest{
		SandboxId: "status-test",
	})

	require.NoError(t, err)
	assert.Equal(t, "status-test", resp.GetSandboxId())
	assert.Equal(t, pb.SandboxState_SANDBOX_STATE_RUNNING, resp.GetState())
	assert.NotNil(t, resp.GetCreatedAt())
}

func TestSandboxStatus_NotFound(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	_, err := client.SandboxStatus(context.Background(), &pb.SandboxStatusRequest{
		SandboxId: "nonexistent",
	})

	require.Error(t, err)
	st, ok := status.FromError(err)
	require.True(t, ok)
	assert.Equal(t, codes.NotFound, st.Code())
}

// --- ListSandboxes tests ---

func TestListSandboxes_WithSandboxes(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	// Create two sandboxes
	_, err := client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "list-1",
	})
	require.NoError(t, err)

	_, err = client.CreateSandbox(context.Background(), &pb.CreateSandboxRequest{
		SandboxId: "list-2",
	})
	require.NoError(t, err)

	resp, err := client.ListSandboxes(context.Background(), &pb.ListSandboxesRequest{})

	require.NoError(t, err)
	assert.Len(t, resp.GetSandboxes(), 2)

	// Collect IDs
	ids := make(map[string]bool)
	for _, s := range resp.GetSandboxes() {
		ids[s.GetSandboxId()] = true
	}
	assert.True(t, ids["list-1"])
	assert.True(t, ids["list-2"])
}

func TestListSandboxes_Empty(t *testing.T) {
	mgr := newMockManager()
	client := setupTestServer(t, mgr)

	resp, err := client.ListSandboxes(context.Background(), &pb.ListSandboxesRequest{})

	require.NoError(t, err)
	assert.Empty(t, resp.GetSandboxes())
}

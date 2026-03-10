package server

import (
	"context"
	"strings"

	pb "github.com/openclaw/vm-runner/gen/go/openclaw/sandbox/v1"
	"github.com/openclaw/vm-runner/internal/vm"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// VMManager defines the interface that the sandbox server needs from the VM manager.
// This enables mock-based testing without requiring real Firecracker/KVM.
type VMManager interface {
	Create(ctx context.Context, req *vm.CreateRequest) (*vm.MachineEntry, error)
	Destroy(ctx context.Context, sandboxID string) error
	Get(sandboxID string) (*vm.MachineEntry, error)
	List() []*vm.MachineEntry
}

// JailCleaner releases jail state (chroot, UID allocation) for a destroyed sandbox.
// If nil, jail cleanup is skipped (e.g., in tests or non-jailed deployments).
type JailCleaner interface {
	Destroy(ctx context.Context, vmID string) error
}

// sandboxServer implements the SandboxServiceServer gRPC interface.
type sandboxServer struct {
	pb.UnimplementedSandboxServiceServer
	mgr         VMManager
	jailCleaner JailCleaner
}

// NewSandboxServer creates a new SandboxService gRPC handler.
// jailCleaner is optional — pass nil to skip jail cleanup on destroy.
func NewSandboxServer(mgr VMManager, jailCleaner JailCleaner) *sandboxServer {
	return &sandboxServer{mgr: mgr, jailCleaner: jailCleaner}
}

// mapStateToProto converts a vm.MachineEntry state string to the proto SandboxState enum.
func mapStateToProto(state string) pb.SandboxState {
	switch state {
	case vm.StateCreating:
		return pb.SandboxState_SANDBOX_STATE_CREATING
	case vm.StateRunning:
		return pb.SandboxState_SANDBOX_STATE_RUNNING
	case vm.StateStopped:
		return pb.SandboxState_SANDBOX_STATE_STOPPED
	case vm.StateError:
		return pb.SandboxState_SANDBOX_STATE_ERROR
	default:
		return pb.SandboxState_SANDBOX_STATE_UNSPECIFIED
	}
}

// CreateSandbox creates a new Firecracker MicroVM sandbox via the Manager.
func (s *sandboxServer) CreateSandbox(ctx context.Context, req *pb.CreateSandboxRequest) (*pb.CreateSandboxResponse, error) {
	createReq := &vm.CreateRequest{
		SandboxID:       req.GetSandboxId(),
		VcpuCount:       req.GetVcpuCount(),
		MemSizeMib:      req.GetMemSizeMib(),
		KernelImagePath: req.GetKernelImagePath(),
		RootfsPath:      req.GetRootfsPath(),
	}

	entry, err := s.mgr.Create(ctx, createReq)
	if err != nil {
		if strings.Contains(err.Error(), "already exists") {
			return nil, status.Errorf(codes.AlreadyExists, "sandbox %s already exists", req.GetSandboxId())
		}
		return nil, status.Errorf(codes.Internal, "failed to create sandbox: %v", err)
	}

	return &pb.CreateSandboxResponse{
		SandboxId: entry.ID,
		CreatedAt: timestamppb.New(entry.CreatedAt),
		State:     mapStateToProto(entry.State),
	}, nil
}

// DestroySandbox destroys a running sandbox via the Manager and cleans up jail state.
func (s *sandboxServer) DestroySandbox(ctx context.Context, req *pb.DestroySandboxRequest) (*pb.DestroySandboxResponse, error) {
	sandboxID := req.GetSandboxId()

	mgrErr := s.mgr.Destroy(ctx, sandboxID)
	mgrNotFound := mgrErr != nil && strings.Contains(mgrErr.Error(), "not found")

	// Always attempt jail cleanup even when the manager returns "not found",
	// because a previous partial destroy may have removed the VM but left
	// stale jail/chroot/UID state that blocks sandbox_id reuse.
	if s.jailCleaner != nil {
		if jlErr := s.jailCleaner.Destroy(ctx, sandboxID); jlErr != nil {
			if !strings.Contains(jlErr.Error(), "not found") {
				return nil, status.Errorf(codes.Internal, "jail cleanup failed: %v", jlErr)
			}
		}
	}

	// Surface manager errors after jail cleanup has been attempted.
	if mgrErr != nil && !mgrNotFound {
		return nil, status.Errorf(codes.Internal, "failed to destroy sandbox: %v", mgrErr)
	}
	if mgrNotFound {
		return nil, status.Errorf(codes.NotFound, "sandbox %s not found", sandboxID)
	}

	return &pb.DestroySandboxResponse{}, nil
}

// SandboxStatus returns the current state of a sandbox via the Manager.
func (s *sandboxServer) SandboxStatus(ctx context.Context, req *pb.SandboxStatusRequest) (*pb.SandboxStatusResponse, error) {
	entry, err := s.mgr.Get(req.GetSandboxId())
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			return nil, status.Errorf(codes.NotFound, "sandbox %s not found", req.GetSandboxId())
		}
		return nil, status.Errorf(codes.Internal, "failed to get sandbox status: %v", err)
	}

	return &pb.SandboxStatusResponse{
		SandboxId: entry.ID,
		State:     mapStateToProto(entry.State),
		CreatedAt: timestamppb.New(entry.CreatedAt),
	}, nil
}

// ListSandboxes returns all sandboxes managed by this runner.
func (s *sandboxServer) ListSandboxes(ctx context.Context, req *pb.ListSandboxesRequest) (*pb.ListSandboxesResponse, error) {
	entries := s.mgr.List()

	sandboxes := make([]*pb.SandboxInfo, 0, len(entries))
	for _, entry := range entries {
		sandboxes = append(sandboxes, &pb.SandboxInfo{
			SandboxId: entry.ID,
			State:     mapStateToProto(entry.State),
			CreatedAt: timestamppb.New(entry.CreatedAt),
		})
	}

	return &pb.ListSandboxesResponse{
		Sandboxes: sandboxes,
	}, nil
}

package envd

import (
	"fmt"
	"net"

	"github.com/mdlayher/vsock"
)

const defaultVsockPort = 50051

// NewVsockListener creates a net.Listener bound to VMADDR_CID_ANY on the given port.
// This is used inside the guest VM to accept connections from the host via virtio-vsock.
func NewVsockListener(port uint32) (net.Listener, error) {
	lis, err := vsock.Listen(port, nil)
	if err != nil {
		return nil, fmt.Errorf("vsock listen on port %d: %w", port, err)
	}
	return lis, nil
}

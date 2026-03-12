package vm

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBuildConfig_Defaults(t *testing.T) {
	cfg := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sandbox-1", 0, 0, 3)
	require.NotNil(t, cfg)

	// Default vCPU count is 1
	assert.Equal(t, int64(1), cfg.VcpuCount)

	// Default memory is 256 MiB
	assert.Equal(t, int64(256), cfg.MemSizeMib)

	// SMT disabled
	assert.False(t, cfg.SmtEnabled)

	// Kernel path
	assert.Equal(t, "/boot/vmlinux", cfg.KernelImagePath)

	// Rootfs path
	assert.Equal(t, "/rootfs/rootfs.ext4", cfg.RootfsPath)

	// Kernel args contain required boot parameters
	assert.Contains(t, cfg.KernelArgs, "reboot=k")
	assert.Contains(t, cfg.KernelArgs, "panic=1")
	assert.Contains(t, cfg.KernelArgs, "pci=off")
	assert.Contains(t, cfg.KernelArgs, "nomodules")
	assert.Contains(t, cfg.KernelArgs, "i8042.noaux")
}

func TestBuildConfig_CustomVcpuAndMem(t *testing.T) {
	cfg := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sandbox-2", 4, 512, 5)

	assert.Equal(t, int64(4), cfg.VcpuCount)
	assert.Equal(t, int64(512), cfg.MemSizeMib)
}

func TestBuildConfig_UniqueSocketPath(t *testing.T) {
	cfg1 := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sandbox-a", 0, 0, 3)
	cfg2 := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sandbox-b", 0, 0, 4)

	assert.Equal(t, filepath.Join("/tmp/socks", "sandbox-a.sock"), cfg1.SocketPath)
	assert.Equal(t, filepath.Join("/tmp/socks", "sandbox-b.sock"), cfg2.SocketPath)
	assert.NotEqual(t, cfg1.SocketPath, cfg2.SocketPath)
}

func TestBuildConfig_VsockCID(t *testing.T) {
	cfg := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sandbox-v", 0, 0, 7)

	assert.Equal(t, uint32(7), cfg.VsockCID)
	assert.Equal(t, filepath.Join("/tmp/socks", "sandbox-v-vsock.sock"), cfg.VsockPath)
}

func TestBuildConfig_VsockUniquePaths(t *testing.T) {
	cfg1 := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sb-1", 0, 0, 3)
	cfg2 := buildConfig("/boot/vmlinux", "/rootfs/rootfs.ext4", "/tmp/socks", "sb-2", 0, 0, 4)

	assert.NotEqual(t, cfg1.VsockPath, cfg2.VsockPath)
}

package jailer

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestChrootPath(t *testing.T) {
	cm := NewChrootManager("/srv/jailer")
	assert.Equal(t, "/srv/jailer/firecracker/test-vm/root", cm.ChrootPath("test-vm"))
}

func TestChrootPathCustomBase(t *testing.T) {
	cm := NewChrootManager("/custom/base")
	assert.Equal(t, "/custom/base/firecracker/my-vm-123/root", cm.ChrootPath("my-vm-123"))
}

func TestChrootManagerBaseDir(t *testing.T) {
	cm := NewChrootManager("/srv/jailer")
	assert.Equal(t, "/srv/jailer", cm.BaseDir())
}

func TestChrootPrepare(t *testing.T) {
	baseDir := t.TempDir()
	cm := NewChrootManager(baseDir)

	// Create fake kernel and rootfs files
	kernelPath := filepath.Join(t.TempDir(), "vmlinux")
	rootfsPath := filepath.Join(t.TempDir(), "rootfs.ext4")
	require.NoError(t, os.WriteFile(kernelPath, []byte("fake-kernel"), 0644))
	require.NoError(t, os.WriteFile(rootfsPath, []byte("fake-rootfs"), 0644))

	err := cm.Prepare("test-vm", kernelPath, rootfsPath)
	require.NoError(t, err)

	// Verify chroot directory was created
	chrootDir := cm.ChrootPath("test-vm")
	info, err := os.Stat(chrootDir)
	require.NoError(t, err)
	assert.True(t, info.IsDir())

	// Verify kernel was linked/copied into chroot
	chrootKernel := filepath.Join(chrootDir, "vmlinux")
	data, err := os.ReadFile(chrootKernel)
	require.NoError(t, err)
	assert.Equal(t, "fake-kernel", string(data))

	// Verify rootfs was linked/copied into chroot
	chrootRootfs := filepath.Join(chrootDir, "rootfs.ext4")
	data, err = os.ReadFile(chrootRootfs)
	require.NoError(t, err)
	assert.Equal(t, "fake-rootfs", string(data))
}

func TestChrootPrepareInvalidVMID(t *testing.T) {
	baseDir := t.TempDir()
	cm := NewChrootManager(baseDir)

	tests := []struct {
		name string
		vmID string
	}{
		{"empty", ""},
		{"too long", string(make([]byte, 65))},
		{"invalid chars", "vm/../../etc"},
		{"spaces", "vm with spaces"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := cm.Prepare(tt.vmID, "/fake/kernel", "/fake/rootfs")
			require.Error(t, err)
			assert.Contains(t, err.Error(), "invalid VM ID")
		})
	}
}

func TestCleanupChroot(t *testing.T) {
	baseDir := t.TempDir()
	cm := NewChrootManager(baseDir)

	// Create fake kernel and rootfs
	kernelPath := filepath.Join(t.TempDir(), "vmlinux")
	rootfsPath := filepath.Join(t.TempDir(), "rootfs.ext4")
	require.NoError(t, os.WriteFile(kernelPath, []byte("k"), 0644))
	require.NoError(t, os.WriteFile(rootfsPath, []byte("r"), 0644))

	require.NoError(t, cm.Prepare("cleanup-vm", kernelPath, rootfsPath))

	// Verify dir exists
	vmDir := filepath.Join(baseDir, "firecracker", "cleanup-vm")
	_, err := os.Stat(vmDir)
	require.NoError(t, err)

	// Cleanup
	err = cm.CleanupChroot("cleanup-vm")
	require.NoError(t, err)

	// Verify dir removed
	_, err = os.Stat(vmDir)
	assert.True(t, os.IsNotExist(err))
}

func TestCleanupChrootIdempotent(t *testing.T) {
	baseDir := t.TempDir()
	cm := NewChrootManager(baseDir)

	// Cleanup non-existent directory should return nil
	err := cm.CleanupChroot("nonexistent-vm")
	require.NoError(t, err)
}

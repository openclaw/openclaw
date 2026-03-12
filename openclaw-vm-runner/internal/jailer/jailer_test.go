package jailer

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLaunchConfigValidation(t *testing.T) {
	t.Run("valid config", func(t *testing.T) {
		cfg := LaunchConfig{
			VMID:       "test-vm-1",
			SessionID:  "session-1",
			KernelPath: "/path/to/vmlinux",
			RootfsPath: "/path/to/rootfs.ext4",
			VcpuCount:  2,
			MemSizeMiB: 512,
		}
		assert.NoError(t, cfg.Validate())
	})

	t.Run("missing VMID", func(t *testing.T) {
		cfg := LaunchConfig{SessionID: "s", KernelPath: "/k", RootfsPath: "/r"}
		assert.Error(t, cfg.Validate())
	})

	t.Run("missing kernel path", func(t *testing.T) {
		cfg := LaunchConfig{VMID: "vm", SessionID: "s", RootfsPath: "/r"}
		assert.Error(t, cfg.Validate())
	})

	t.Run("missing rootfs path", func(t *testing.T) {
		cfg := LaunchConfig{VMID: "vm", SessionID: "s", KernelPath: "/k"}
		assert.Error(t, cfg.Validate())
	})
}

func TestBuildJailerConfig(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "2",
		entries:        make(map[string]*LaunchResult),
	}

	cfg := LaunchConfig{
		VMID:             "test-build",
		SessionID:        "session-build",
		KernelPath:       "/kernel",
		RootfsPath:       "/rootfs",
		VcpuCount:        2,
		MemSizeMiB:       512,
		NetworkNamespace: "openclaw-test",
	}

	jcfg, uid, err := jl.buildJailerConfig(cfg)
	require.NoError(t, err)

	// UID/GID allocated from pool
	assert.True(t, uid >= 10000 && uid <= 10010)
	assert.Equal(t, uid, *jcfg.UID)
	assert.Equal(t, uid, *jcfg.GID)

	// Jailer config basics
	assert.Equal(t, "test-build", jcfg.ID)
	assert.Equal(t, "/usr/bin/firecracker", jcfg.ExecFile)
	assert.Equal(t, "/usr/bin/jailer", jcfg.JailerBinary)
	assert.Equal(t, baseDir, jcfg.ChrootBaseDir)
	assert.True(t, jcfg.Daemonize)
	assert.Equal(t, "2", jcfg.CgroupVersion)

	// Cgroup args include memory and CPU limits
	assert.Contains(t, jcfg.CgroupArgs, "memory.limit_in_bytes=536870912") // 512 MiB
	assert.Contains(t, jcfg.CgroupArgs, "cpu.cfs_quota_us=200000")         // 2 vcpus
	assert.Contains(t, jcfg.CgroupArgs, "cpu.cfs_period_us=100000")

	// Network namespace
	assert.Equal(t, "openclaw-test", jcfg.NetNS)

	// UID allocated
	assert.Equal(t, 1, pool.InUse())
}

func TestBuildJailerConfigDefaults(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "1",
		entries:        make(map[string]*LaunchResult),
	}

	cfg := LaunchConfig{
		VMID:       "defaults-vm",
		SessionID:  "session-1",
		KernelPath: "/k",
		RootfsPath: "/r",
		VcpuCount:  0,  // should default to 1
		MemSizeMiB: 0,  // should default to 256
	}

	jcfg, _, err := jl.buildJailerConfig(cfg)
	require.NoError(t, err)

	assert.Contains(t, jcfg.CgroupArgs, "memory.limit_in_bytes=268435456") // 256 MiB
	assert.Contains(t, jcfg.CgroupArgs, "cpu.cfs_quota_us=100000")         // 1 vcpu
}

func TestJailedLauncherDestroy(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "2",
		entries:        make(map[string]*LaunchResult),
	}

	// Create a fake chroot dir and register an entry
	vmID := "destroy-test"
	vmDir := filepath.Join(baseDir, "firecracker", vmID, "root")
	require.NoError(t, os.MkdirAll(vmDir, 0755))

	uid, _, err := pool.Allocate()
	require.NoError(t, err)

	jl.entries[vmID] = &LaunchResult{
		PID:       0, // no real process
		ChrootDir: cm.ChrootPath(vmID),
		UID:       uid,
	}

	err = jl.Destroy(context.Background(), vmID)
	require.NoError(t, err)

	// Chroot should be cleaned up
	_, err = os.Stat(filepath.Join(baseDir, "firecracker", vmID))
	assert.True(t, os.IsNotExist(err))

	// UID should be released
	assert.Equal(t, 0, pool.InUse())

	// Entry should be removed
	assert.Nil(t, jl.entries[vmID])
}

func TestJailedLauncherDestroyUnknown(t *testing.T) {
	jl := &JailedLauncher{
		entries: make(map[string]*LaunchResult),
	}

	err := jl.Destroy(context.Background(), "nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

func TestJailedLauncherActiveVMs(t *testing.T) {
	jl := &JailedLauncher{
		entries: map[string]*LaunchResult{
			"vm-1": {PID: 100, UID: 10000},
			"vm-2": {PID: 200, UID: 10001},
		},
	}

	vms := jl.ActiveVMs()
	assert.Equal(t, 2, len(vms))
}

func TestDetectCgroupVersion(t *testing.T) {
	// This test verifies the function doesn't panic and returns a valid value
	v := detectCgroupVersion()
	assert.True(t, v == "1" || v == "2", "cgroup version must be 1 or 2, got: %s", v)
}

func TestPrepareJail(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "2",
		entries:        make(map[string]*LaunchResult),
	}

	// Create fake kernel and rootfs files (required by ChrootManager.Prepare)
	kernelPath := filepath.Join(t.TempDir(), "vmlinux")
	rootfsPath := filepath.Join(t.TempDir(), "rootfs.ext4")
	require.NoError(t, os.WriteFile(kernelPath, []byte("fake-kernel"), 0644))
	require.NoError(t, os.WriteFile(rootfsPath, []byte("fake-rootfs"), 0644))

	cfg := LaunchConfig{
		VMID:             "prepare-test",
		SessionID:        "session-1",
		KernelPath:       kernelPath,
		RootfsPath:       rootfsPath,
		VcpuCount:        2,
		MemSizeMiB:       512,
		NetworkNamespace: "openclaw-test",
	}

	jcfg, result, err := jl.PrepareJail(context.Background(), cfg)
	require.NoError(t, err)

	// JailerConfig should have valid fields
	require.NotNil(t, jcfg)
	assert.NotNil(t, jcfg.UID)
	assert.NotNil(t, jcfg.GID)
	assert.True(t, *jcfg.UID >= 10000 && *jcfg.UID <= 10010)
	assert.Equal(t, *jcfg.UID, *jcfg.GID)
	assert.Equal(t, "prepare-test", jcfg.ID)
	assert.Equal(t, "/usr/bin/firecracker", jcfg.ExecFile)
	assert.Equal(t, "/usr/bin/jailer", jcfg.JailerBinary)
	assert.Equal(t, baseDir, jcfg.ChrootBaseDir)
	assert.True(t, jcfg.Daemonize)
	assert.Equal(t, "2", jcfg.CgroupVersion)
	assert.Equal(t, "openclaw-test", jcfg.NetNS)

	// LaunchResult should have PID=0, valid chroot path, allocated UID
	require.NotNil(t, result)
	assert.Equal(t, 0, result.PID)
	assert.Equal(t, cm.ChrootPath("prepare-test"), result.ChrootDir)
	assert.Equal(t, *jcfg.UID, result.UID)

	// Chroot directory should exist with kernel and rootfs
	chrootDir := cm.ChrootPath("prepare-test")
	_, err = os.Stat(chrootDir)
	require.NoError(t, err)
	data, err := os.ReadFile(filepath.Join(chrootDir, "vmlinux"))
	require.NoError(t, err)
	assert.Equal(t, "fake-kernel", string(data))

	// Entry should be tracked
	assert.Equal(t, 1, len(jl.ActiveVMs()))

	// UID should be allocated
	assert.Equal(t, 1, pool.InUse())
}

func TestPrepareJailDuplicate(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "2",
		entries:        make(map[string]*LaunchResult),
	}

	// Create fake kernel and rootfs files
	kernelPath := filepath.Join(t.TempDir(), "vmlinux")
	rootfsPath := filepath.Join(t.TempDir(), "rootfs.ext4")
	require.NoError(t, os.WriteFile(kernelPath, []byte("fake-kernel"), 0644))
	require.NoError(t, os.WriteFile(rootfsPath, []byte("fake-rootfs"), 0644))

	cfg := LaunchConfig{
		VMID:       "dup-test",
		SessionID:  "session-1",
		KernelPath: kernelPath,
		RootfsPath: rootfsPath,
	}

	_, _, err := jl.PrepareJail(context.Background(), cfg)
	require.NoError(t, err)

	// Second call with same VMID should fail
	_, _, err = jl.PrepareJail(context.Background(), cfg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "already exists")
}

func TestReleaseJail(t *testing.T) {
	baseDir := t.TempDir()
	pool := NewUIDPool(10000, 10010)
	cm := NewChrootManager(baseDir)

	jl := &JailedLauncher{
		uidPool:        pool,
		chrootMgr:      cm,
		firecrackerBin: "/usr/bin/firecracker",
		jailerBin:      "/usr/bin/jailer",
		cgroupVersion:  "2",
		entries:        make(map[string]*LaunchResult),
	}

	// Create fake kernel and rootfs files
	kernelPath := filepath.Join(t.TempDir(), "vmlinux")
	rootfsPath := filepath.Join(t.TempDir(), "rootfs.ext4")
	require.NoError(t, os.WriteFile(kernelPath, []byte("fake-kernel"), 0644))
	require.NoError(t, os.WriteFile(rootfsPath, []byte("fake-rootfs"), 0644))

	cfg := LaunchConfig{
		VMID:       "release-test",
		SessionID:  "session-1",
		KernelPath: kernelPath,
		RootfsPath: rootfsPath,
	}

	_, _, err := jl.PrepareJail(context.Background(), cfg)
	require.NoError(t, err)

	// Chroot should exist
	chrootDir := cm.ChrootPath("release-test")
	_, err = os.Stat(chrootDir)
	require.NoError(t, err)

	// UID should be allocated
	assert.Equal(t, 1, pool.InUse())

	// Release the jail
	err = jl.ReleaseJail("release-test")
	require.NoError(t, err)

	// Chroot should be cleaned up
	vmDir := filepath.Join(baseDir, "firecracker", "release-test")
	_, err = os.Stat(vmDir)
	assert.True(t, os.IsNotExist(err))

	// UID should be released
	assert.Equal(t, 0, pool.InUse())

	// Entry should be removed
	assert.Equal(t, 0, len(jl.ActiveVMs()))
}

func TestReleaseJailUnknown(t *testing.T) {
	jl := &JailedLauncher{
		entries: make(map[string]*LaunchResult),
	}

	err := jl.ReleaseJail("nonexistent")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "not found")
}

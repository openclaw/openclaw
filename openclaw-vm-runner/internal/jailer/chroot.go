package jailer

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"syscall"
)

var validVMID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9\-]*$`)

// ChrootManager handles pre-launch file linking and post-destruction cleanup
// of Jailer chroot directories.
type ChrootManager struct {
	baseDir string
}

// NewChrootManager creates a ChrootManager with the given base directory.
// The default Jailer base directory is "/srv/jailer".
func NewChrootManager(baseDir string) *ChrootManager {
	return &ChrootManager{baseDir: baseDir}
}

// BaseDir returns the chroot base directory for filesystem scanning.
func (cm *ChrootManager) BaseDir() string {
	return cm.baseDir
}

// ChrootPath returns the root directory path inside the chroot for the given VM.
func (cm *ChrootManager) ChrootPath(vmID string) string {
	return filepath.Join(cm.baseDir, "firecracker", vmID, "root")
}

// Prepare creates the chroot directory structure and hard-links (or copies)
// the kernel and rootfs into it.
func (cm *ChrootManager) Prepare(vmID, kernelPath, rootfsPath string) error {
	if err := validateVMID(vmID); err != nil {
		return err
	}

	chrootDir := cm.ChrootPath(vmID)
	if err := os.MkdirAll(chrootDir, 0755); err != nil {
		return fmt.Errorf("failed to create chroot directory %s: %w", chrootDir, err)
	}

	// Hard-link kernel into chroot (fall back to copy if cross-device)
	dstKernel := filepath.Join(chrootDir, filepath.Base(kernelPath))
	if err := linkOrCopy(kernelPath, dstKernel); err != nil {
		return fmt.Errorf("failed to link kernel into chroot: %w", err)
	}

	// Hard-link rootfs into chroot (fall back to copy if cross-device)
	dstRootfs := filepath.Join(chrootDir, filepath.Base(rootfsPath))
	if err := linkOrCopy(rootfsPath, dstRootfs); err != nil {
		return fmt.Errorf("failed to link rootfs into chroot: %w", err)
	}

	return nil
}

// CleanupChroot removes the entire chroot directory tree for a VM.
// Returns nil if the directory does not exist (idempotent).
func (cm *ChrootManager) CleanupChroot(vmID string) error {
	vmDir := filepath.Join(cm.baseDir, "firecracker", vmID)
	err := os.RemoveAll(vmDir)
	if err != nil {
		return fmt.Errorf("failed to clean up chroot %s: %w", vmDir, err)
	}
	return nil
}

func validateVMID(vmID string) error {
	if vmID == "" || len(vmID) > 64 || !validVMID.MatchString(vmID) {
		return fmt.Errorf("invalid VM ID %q: must be 1-64 alphanumeric characters or hyphens, starting with alphanumeric", vmID)
	}
	return nil
}

// linkOrCopy attempts a hard link; falls back to file copy only on cross-device errors.
func linkOrCopy(src, dst string) error {
	if err := os.Link(src, dst); err != nil {
		if errors.Is(err, syscall.EXDEV) {
			return copyFile(src, dst)
		}
		return err
	}
	return nil
}

func copyFile(src, dst string) error {
	// Verify dst does not already exist (e.g. as a symlink).
	if _, err := os.Lstat(dst); err == nil {
		return fmt.Errorf("destination already exists: %s", dst)
	}

	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	// Use O_EXCL to atomically ensure the file is created new, and O_WRONLY
	// instead of os.Create to avoid following symlinks placed at dst.
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	return out.Close()
}

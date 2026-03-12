package reaper

import (
	"log/slog"
	"syscall"
	"unsafe"
)

// setChildSubreaper calls PR_SET_CHILD_SUBREAPER on Linux so that orphaned
// grandchildren (daemonized Firecracker processes) are re-parented to this
// process instead of PID 1.
func setChildSubreaper(logger *slog.Logger) {
	_, _, errno := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_CHILD_SUBREAPER, 1, 0)
	if errno != 0 {
		logger.Error("failed to set PR_SET_CHILD_SUBREAPER", "errno", errno)
		return
	}

	// Verify it was set
	var result uintptr
	_, _, errno = syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_GET_CHILD_SUBREAPER, uintptr(unsafe.Pointer(&result)), 0)
	if errno != 0 || result != 1 {
		logger.Error("PR_SET_CHILD_SUBREAPER verification failed", "result", result, "errno", errno)
		return
	}
	logger.Info("registered as child subreaper")
}

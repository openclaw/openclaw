//go:build !linux

package reaper

import "log/slog"

// setChildSubreaper is a no-op on non-Linux platforms.
// PR_SET_CHILD_SUBREAPER is a Linux-specific prctl operation.
func setChildSubreaper(logger *slog.Logger) {
	logger.Warn("PR_SET_CHILD_SUBREAPER not available on this platform")
}

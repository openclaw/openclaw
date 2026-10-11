# Based on Moby v28.0.4 profiles/apparmor/template.go (Apache-2.0).
# Modified for this live-test container's nested Codex sandbox setup.
#include <tunables/global>

profile @OPENCLAW_CODEX_LIVE_PROFILE@ flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  capability,
  file,
  umount,
  signal (receive) peer=unconfined,
  signal (receive) peer=runc,
  signal (receive) peer=crun,
  signal (send,receive) peer=@OPENCLAW_CODEX_LIVE_PROFILE@,

  deny @{PROC}/* w,
  deny @{PROC}/{[^1-9],[^1-9][^0-9],[^1-9s][^0-9y][^0-9s],[^1-9][^0-9][^0-9][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,

  # Bubblewrap creates private mounts before dropping namespace-local caps.
  userns,
  mount options=(rw,rslave,silent) -> /,
  mount options=(rw,rprivate,silent) -> /oldroot/,
  mount options=(rw,bind) /** -> /**,
  mount options=(rw,rbind) /** -> /**,
  remount options in (ro,rw,bind,nosuid,nodev,noexec,relatime,noatime,nodiratime,silent) /**,
  mount fstype=tmpfs options=(rw,nosuid,nodev) -> /**,
  mount fstype=proc options=(rw,nosuid,nodev,noexec) -> /**,
  mount fstype=devpts options=(rw,nosuid,noexec) -> /**,
  pivot_root,

  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  ptrace (trace,read,tracedby,readby) peer=@OPENCLAW_CODEX_LIVE_PROFILE@,
}

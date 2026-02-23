/**
 * Configuration for bubblewrap (bwrap) sandbox backend.
 *
 * Unlike Docker, bwrap creates a fresh mount/pid/net namespace per command
 * invocation — there is no persistent container. This config describes the
 * namespace shape that every bwrap invocation will use.
 */
export type SandboxBwrapConfig = {
  /** Working directory inside the namespace (workspace mount target). */
  workdir: string;

  /** Mount the root filesystem read-only. Default: true. */
  readOnlyRoot: boolean;

  /**
   * Paths to mount as tmpfs inside the namespace.
   * Default: ["/tmp", "/var/tmp", "/run"].
   */
  tmpfs: string[];

  /** Disable network access via --unshare-net. Default: true (no network). */
  unshareNet: boolean;

  /** Unshare PID namespace. Default: true. */
  unsharePid: boolean;

  /** Unshare IPC namespace. Default: true. */
  unshareIpc: boolean;

  /** Unshare cgroup namespace. Default: false. */
  unshareCgroup: boolean;

  /** Use --new-session to prevent TIOCSTI attacks. Default: true. */
  newSession: boolean;

  /** Use --die-with-parent to kill sandbox when parent exits. Default: true. */
  dieWithParent: boolean;

  /**
   * Mount a /proc filesystem inside the namespace.
   * Disable when running bwrap in an already containerised gateway
   * with no permission to mount /proc.
   *
   * Default: true.
   */
  mountProc: boolean;

  /**
   * Additional read-only bind mounts: "hostPath:containerPath".
   * For writable binds, suffix with ":rw" → "hostPath:containerPath:rw".
   */
  extraBinds?: string[];

  /**
   * Host paths to bind read-only into the namespace for a functioning
   * userland. Defaults cover /usr, /lib, /lib64, /bin, /sbin, /etc.
   */
  rootBinds?: string[];

  /** Environment variables to set inside the namespace. */
  env?: Record<string, string>;
};

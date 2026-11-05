#!/usr/bin/python3
"""Admit either fixed Team maintenance job, then join its runtime descendants."""

import ctypes
import errno
import fcntl
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import sys
import time


ROOT = Path("/opt/openclaw-team")
LOCK = Path("/run/openclaw-release-deploy.lock")
LIBRARY = Path("/usr/local/lib/openclaw-team/release-lib.mjs")
JOBS = {
    "0::/system.slice/openclaw-disk-maintenance.service": "openclaw-disk-maintenance",
    "0::/system.slice/openclaw-hourly-health-check.service": "openclaw-health-check",
}
PR_SET_CHILD_SUBREAPER = 36
HANDLED_SIGNALS = (signal.SIGTERM, signal.SIGINT, signal.SIGQUIT)


class StopSignal:
    def __init__(self):
        self.signum = 0

    def record(self, signum, _frame):
        self.signum = self.signum or signum


def root_owned(path, *, directory=False):
    metadata = path.lstat()
    kind = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        not kind(metadata.st_mode)
        or metadata.st_uid != 0
        or metadata.st_gid != 0
        or metadata.st_mode & 0o022
        or (not directory and metadata.st_nlink != 1)
    ):
        raise RuntimeError("unsafe maintenance admission path")
    return metadata


def validate_release(runtime, body):
    for path in (Path("/usr"), Path("/usr/local"), LIBRARY.parent.parent, LIBRARY.parent):
        root_owned(path, directory=True)
    root_owned(LIBRARY)
    root_owned(body)
    environment = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}

    def proof(*arguments):
        result = subprocess.run(
            ["/usr/bin/node", str(LIBRARY), *arguments],
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            pass_fds=(9,),
        )
        if result.returncode != 0:
            stderr_tail = result.stderr[-2000:].decode(errors="replace").strip()
            raise RuntimeError(f"release proof {arguments[0]} failed (exit {result.returncode}): {stderr_tail}")

    proof("audit-root", str(ROOT), "0", str(runtime.pw_uid), str(pwd.getpwnam("openclaw-deploy").pw_uid), "/")
    pointer = (ROOT / "current").lstat()
    if not stat.S_ISLNK(pointer.st_mode) or pointer.st_uid != 0 or pointer.st_gid != 0:
        raise RuntimeError("unsafe current release pointer")
    release = (ROOT / "current").resolve(strict=True)
    if release.parent != ROOT / "releases" or not re.fullmatch(r"[a-f0-9]{40}", release.name):
        raise RuntimeError("current release escapes the serving namespace")
    proof("validate-release", str(release), release.name, "0", "sealed")
    root_owned(release / "openclaw.mjs")
    return release / "openclaw.mjs"


def run_and_join(runtime, cli, body, *, stop_signal, status_context=None, report=None):
    signaled = set()
    for signum in HANDLED_SIGNALS:
        signal.signal(signum, stop_signal.record)
    home = runtime.pw_dir
    environment = {
        "HOME": home,
        "USER": runtime.pw_name,
        "LOGNAME": runtime.pw_name,
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "LANG": "C.UTF-8",
        "XDG_CONFIG_HOME": f"{home}/.config",
        "XDG_CACHE_HOME": f"{home}/.cache",
        "XDG_STATE_HOME": f"{home}/.local/state",
        "XDG_RUNTIME_DIR": f"/run/user/{runtime.pw_uid}",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{runtime.pw_uid}/bus",
        "OPENCLAW_SUPERVISOR_MODE": "external",
        "OPENCLAW_SYSTEMD_UNIT": "openclaw-gateway.service",
        "OPENCLAW_SERVICE_REPAIR_POLICY": "external",
    }
    if status_context is not None:
        environment["INVOCATION_ID"] = status_context[0]
        environment["OPENCLAW_MAINTENANCE_STARTED_AT_MS"] = str(status_context[1])
    arguments = ["--report-only", *report] if report is not None else [str(cli)]
    groups = os.getgrouplist(runtime.pw_name, runtime.pw_gid)
    previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
    try:
        pending = signal.sigpending()
        if stop_signal.signum or any(signum in pending for signum in HANDLED_SIGNALS):
            raise SystemExit(128 + (stop_signal.signum or next(signum for signum in HANDLED_SIGNALS if signum in pending)))

        def child_signals():
            # This launcher is single-threaded. Popen does not restore a parent's
            # blocked mask; the runtime child must receive normal stop signals.
            for signum in HANDLED_SIGNALS:
                signal.signal(signum, signal.SIG_DFL)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)

        primary = subprocess.Popen(
            ["/bin/bash", "--noprofile", "--norc", str(body), *arguments],
            cwd=cli.parent if body.name == "openclaw-health-check" else home,
            env=environment,
            user=runtime.pw_uid,
            group=runtime.pw_gid,
            extra_groups=groups,
            preexec_fn=child_signals,
        )
    finally:
        # A signal queued after the admission decision is delivered here, then
        # the join loop forwards it while retaining the canonical lock.
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)
    while True:
        if stop_signal.signum:
            children = Path(f"/proc/self/task/{os.getpid()}/children").read_text().split()
            for value in children:
                pid = int(value)
                if pid in signaled:
                    continue
                try:
                    descriptor = os.pidfd_open(pid)
                except ProcessLookupError:
                    continue
                try:
                    # A pidfd pins identity; waitid proves this is still our child.
                    if os.waitid(os.P_PIDFD, descriptor, os.WEXITED | os.WNOHANG | os.WNOWAIT) is None:
                        signal.pidfd_send_signal(descriptor, stop_signal.signum)
                        signaled.add(pid)
                except (ChildProcessError, ProcessLookupError):
                    pass
                finally:
                    os.close(descriptor)
        try:
            pid, outcome = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if pid == primary.pid:
            primary.returncode = os.waitstatus_to_exitcode(outcome)
        if pid:
            signaled.discard(pid)
        else:
            time.sleep(0.02)
    if stop_signal.signum:
        # All descendants are reaped. A handled stop ends this invocation,
        # rather than entering ordinary child-failure reporting.
        raise SystemExit(128 + stop_signal.signum)
    result = primary.returncode
    if result is None:
        raise RuntimeError("maintenance exit was not observed")
    return result if result >= 0 else 128 - result


def main():
    if sys.platform != "linux" or sys.version_info < (3, 9) or os.getuid() != 0 or len(sys.argv) != 1:
        raise RuntimeError("maintenance launcher requires Linux root, Python 3.9+, and no arguments")
    job = JOBS.get(Path("/proc/self/cgroup").read_text().strip())
    if job is None:
        raise RuntimeError("maintenance launcher requires its guarded system service cgroup")
    # Stop intent belongs to the invocation, including the reporting handoff.
    stop_signal = StopSignal()
    body = LIBRARY.parent / job
    # CLI grandchildren may close inherited descriptors or outlive their parent.
    # Keep our own lock until all adopted descendants have actually been reaped.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "cannot join maintenance descendants")
    # A deferred disk job must report through its fixed status writer without
    # resolving or invoking any release CLI. The health sibling keeps its path.
    status_context = None
    report_attempted = False
    if job == "openclaw-disk-maintenance":
        for path in (Path("/usr"), Path("/usr/local"), LIBRARY.parent.parent, LIBRARY.parent):
            root_owned(path, directory=True)
        root_owned(body)
        runtime = pwd.getpwnam("openclaw")
        if runtime.pw_uid == 0 or runtime.pw_gid == 0 or runtime.pw_dir != "/home/openclaw":
            raise RuntimeError("unexpected maintenance runtime identity")
        invocation = os.environ.get("INVOCATION_ID", "")
        if not re.fullmatch(r"[a-f0-9]{32}", invocation):
            raise RuntimeError("disk maintenance requires its native invocation identity")
        status_context = (invocation, time.time_ns() // 1_000_000)

    def report(phase, reason, exit_code=0):
        nonlocal report_attempted
        if status_context is None:
            return
        report_attempted = True
        outcome = run_and_join(
            runtime, None, body, stop_signal=stop_signal, status_context=status_context,
            report=(phase, reason, str(exit_code)),
        )
        if outcome != 0:
            raise RuntimeError("disk maintenance status could not be published")

    root_owned(LOCK.parent, directory=True)
    expected = root_owned(LOCK)
    lock_fd = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    proof_fd_open = False
    try:
        held = os.fstat(lock_fd)
        if (held.st_dev, held.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError("canonical lock changed while opening")
        try:
            # Release admission requires the deployer's exclusive lock on FD 9.
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            report("deferred", "deployment-lock")
            print(f"{job}: deferred; deployment owns the lock")
            return 0
        try:
            os.fstat(9)
        except OSError as error:
            if error.errno != errno.EBADF:
                raise
        else:
            raise RuntimeError("maintenance launcher requires FD 9 to be closed")
        os.dup2(lock_fd, 9, inheritable=False)
        proof_fd_open = True
        root_owned(Path("/opt"), directory=True)
        root_owned(ROOT, directory=True)
        journal_directory = root_owned(ROOT / "journal", directory=True)
        if journal_directory.st_mode & 0o077:
            raise RuntimeError("deployment journal namespace is not private")
        try:
            (ROOT / "journal/activation.json").lstat()
        except FileNotFoundError:
            pass
        else:
            report("deferred", "recovery-pending")
            print(f"{job}: deferred; deployment recovery is unresolved")
            return 0
        runtime = pwd.getpwnam("openclaw")
        if runtime.pw_uid == 0 or runtime.pw_gid == 0 or runtime.pw_dir != "/home/openclaw":
            raise RuntimeError("unexpected maintenance runtime identity")
        cli = validate_release(runtime, body)
        current_lock = root_owned(LOCK)
        if (held.st_dev, held.st_ino) != (current_lock.st_dev, current_lock.st_ino):
            raise RuntimeError("canonical lock changed during admission")
        outcome = run_and_join(runtime, cli, body, stop_signal=stop_signal, status_context=status_context)
        if outcome != 0:
            report("failed", "execution-failed", outcome)
        return outcome
    except (OSError, RuntimeError, KeyError, subprocess.SubprocessError):
        if not report_attempted:
            report("failed", "admission-failed", 1)
        raise
    finally:
        if proof_fd_open:
            os.close(9)
        os.close(lock_fd)
        # Commit the process outcome after cleanup. Keep signals blocked through
        # interpreter exit, so a later stop cannot be consumed after this decision.
        signal.pthread_sigmask(signal.SIG_BLOCK, HANDLED_SIGNALS)
        pending = signal.sigpending()
        if stop_signal.signum or any(signum in pending for signum in HANDLED_SIGNALS):
            raise SystemExit(128 + (stop_signal.signum or next(signum for signum in HANDLED_SIGNALS if signum in pending)))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print(f"maintenance: admission or execution failed: {error}; inspect the service", file=sys.stderr)
        sys.exit(1)

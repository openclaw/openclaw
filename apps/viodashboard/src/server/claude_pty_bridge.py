#!/usr/bin/env python3
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time
from typing import Optional


def usage() -> int:
    print(
        'usage: claude_pty_bridge.py --cwd <cwd> --log <log_path> --stdin <fifo_path> [--status <status_path>] -- <command> [args...]',
        file=sys.stderr,
    )
    return 2


class BridgeState:
    def __init__(self, log_path: str, status_path: Optional[str] = None):
        self.log_path = log_path
        self.status_path = status_path
        self.child_pid: Optional[int] = None
        self.master_fd: Optional[int] = None
        self.child_exited = False
        self.child_exit_code: Optional[int] = None
        self.stop_requested = False

    def append_log(self, text: str) -> None:
        os.makedirs(os.path.dirname(self.log_path), exist_ok=True)
        with open(self.log_path, 'a', encoding='utf-8', errors='replace') as fh:
            fh.write(text)
            fh.flush()

    def write_status(self, status: str, exit_code: Optional[int] = None, error: Optional[str] = None) -> None:
        if not self.status_path:
            return
        payload = {
            'status': status,
            'bridgePid': os.getpid(),
            'childPid': self.child_pid,
            'exitCode': exit_code,
            'error': error,
            'updatedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        os.makedirs(os.path.dirname(self.status_path), exist_ok=True)
        import json

        with open(self.status_path, 'w', encoding='utf-8') as fh:
            json.dump(payload, fh)
            fh.write('\n')


def parse_args(argv):
    cwd = None
    log_path = None
    stdin_path = None
    status_path = None
    resize_path = None
    idx = 0
    while idx < len(argv):
        token = argv[idx]
        if token == '--':
            idx += 1
            break
        if token == '--cwd' and idx + 1 < len(argv):
            cwd = argv[idx + 1]
            idx += 2
            continue
        if token == '--log' and idx + 1 < len(argv):
            log_path = argv[idx + 1]
            idx += 2
            continue
        if token == '--stdin' and idx + 1 < len(argv):
            stdin_path = argv[idx + 1]
            idx += 2
            continue
        if token == '--status' and idx + 1 < len(argv):
            status_path = argv[idx + 1]
            idx += 2
            continue
        if token == '--resize' and idx + 1 < len(argv):
            resize_path = argv[idx + 1]
            idx += 2
            continue
        return None
    command = argv[idx:]
    if not cwd or not log_path or not stdin_path or not command:
        return None
    return cwd, log_path, stdin_path, status_path, resize_path, command


def main() -> int:
    parsed = parse_args(sys.argv[1:])
    if parsed is None:
        return usage()

    cwd, log_path, stdin_path, status_path, resize_path, command = parsed
    state = BridgeState(log_path=log_path, status_path=status_path)

    os.makedirs(os.path.dirname(log_path), exist_ok=True)
    os.makedirs(os.path.dirname(stdin_path), exist_ok=True)
    if os.path.exists(stdin_path):
        os.unlink(stdin_path)
    os.mkfifo(stdin_path)

    def request_stop(signum, _frame):
        state.stop_requested = True
        if state.child_pid:
            try:
                os.kill(state.child_pid, signum)
            except OSError:
                pass

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)

    pid, master_fd = pty.fork()
    if pid == 0:
        os.chdir(cwd)
        env = os.environ.copy()
        env.setdefault('TERM', 'xterm-256color')
        env.setdefault('COLORTERM', 'truecolor')
        os.execvpe(command[0], command, env)
        return 127

    state.child_pid = pid
    state.master_fd = master_fd
    state.append_log(f"[bridge] started pid={os.getpid()} child={pid} cwd={cwd}\n")
    state.write_status('running')

    fifo_fd = None
    fifo_keepalive_fd = None
    try:
        fifo_fd = os.open(stdin_path, os.O_RDONLY | os.O_NONBLOCK)
        fifo_keepalive_fd = os.open(stdin_path, os.O_WRONLY | os.O_NONBLOCK)
        while True:
            read_fds = [master_fd]
            if fifo_fd is not None:
                read_fds.append(fifo_fd)
            ready, _, _ = select.select(read_fds, [], [], 0.1)

            if master_fd in ready:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    data = b''
                if data:
                    state.append_log(data.decode('utf-8', errors='replace'))
                else:
                    state.child_exited = True
                    break

            if fifo_fd is not None and fifo_fd in ready:
                try:
                    incoming = os.read(fifo_fd, 4096)
                except OSError:
                    incoming = b''
                if incoming:
                    try:
                        os.write(master_fd, incoming)
                    except OSError:
                        pass

            # Apply pending PTY resize if Node wrote a resize file.
            if resize_path and os.path.exists(resize_path):
                try:
                    with open(resize_path, 'r') as f:
                        sz = json.load(f)
                    os.unlink(resize_path)
                    cols = max(1, min(500, int(sz.get('cols', 80))))
                    rows = max(1, min(200, int(sz.get('rows', 24))))
                    fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                except Exception:
                    pass

            if not state.child_exited:
                try:
                    waited_pid, status = os.waitpid(pid, os.WNOHANG)
                except ChildProcessError:
                    waited_pid, status = pid, 0
                if waited_pid == pid:
                    state.child_exited = True
                    if os.WIFEXITED(status):
                        state.child_exit_code = os.WEXITSTATUS(status)
                    elif os.WIFSIGNALED(status):
                        state.child_exit_code = 128 + os.WTERMSIG(status)
                    else:
                        state.child_exit_code = 1
                    break

        exit_code = state.child_exit_code if state.child_exit_code is not None else 0
        final_status = 'terminated' if state.stop_requested else 'exited'
        state.append_log(f"\n[bridge] {final_status} exit={exit_code}\n")
        state.write_status(final_status, exit_code=exit_code)
        return exit_code
    finally:
        if fifo_keepalive_fd is not None:
            try:
                os.close(fifo_keepalive_fd)
            except OSError:
                pass
        if fifo_fd is not None:
            try:
                os.close(fifo_fd)
            except OSError:
                pass
        try:
            os.close(master_fd)
        except OSError:
            pass
        # Keep FIFO for reconnects while running; remove it on process exit only.
        try:
            if os.path.exists(stdin_path):
                os.unlink(stdin_path)
        except OSError:
            pass


if __name__ == '__main__':
    raise SystemExit(main())

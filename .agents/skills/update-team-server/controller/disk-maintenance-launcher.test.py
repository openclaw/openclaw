"""Linux descriptor-boundary regression; run as a non-root user with Node."""

import contextlib
import fcntl
import importlib.util
import io
import os
from pathlib import Path
import pwd
import shutil
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


GUARD = "openclaw-team-release: retained preparation requires the exact existing exclusive deployment lock"


@unittest.skipUnless(sys.platform == "linux", "requires Linux flock and /proc/self/fdinfo")
class LauncherTest(unittest.TestCase):
    def setUp(self):
        self.assertNotEqual(os.getuid(), 0, "run this test as a non-root user")
        spec = importlib.util.spec_from_file_location(
            "maintenance_launcher", Path(__file__).with_name("disk-maintenance-launcher.py")
        )
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.lock = self.root / "deploy.lock"
        self.lock.touch()
        (self.root / "journal").mkdir(mode=0o700)
        self.release = self.root / "releases" / ("a" * 40)
        self.release.mkdir(parents=True)
        (self.release / "openclaw.mjs").touch()
        self.current = self.root / "current"
        self.current.symlink_to(self.release)
        self.library = self.root / "release-lib.mjs"
        self.library.write_text(r'''
import fs from 'node:fs';
try {
  const held = fs.fstatSync(9);
  const expected = fs.statSync(new URL('./deploy.lock', import.meta.url));
  if (held.dev !== expected.dev || held.ino !== expected.ino ||
      !/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+/m.test(fs.readFileSync('/proc/self/fdinfo/9', 'utf8'))) {
    throw new Error('wrong lock');
  }
} catch {
  console.error('openclaw-team-release: retained preparation requires the exact existing exclusive deployment lock');
  process.exit(2);
}
''')
        self.runtime = SimpleNamespace(
            pw_uid=os.getuid(),
            pw_gid=os.getgid(),
            pw_name=pwd.getpwuid(os.getuid()).pw_name,
            pw_dir="/home/openclaw",
        )
        self.body = self.root / "openclaw-health-check"
        self.body.write_text("raise SystemExit(0)\n")
        (self.root / "verified").mkdir(mode=0o700)
        (self.root / "verified" / self.release.name).write_text(self.release.name + "\n")
        stack = self.enterContext(contextlib.ExitStack())
        for name, value in (("ROOT", self.root), ("LOCK", self.lock), ("LIBRARY", self.library)):
            stack.enter_context(patch.object(self.launcher, name, value))
        stack.enter_context(patch.object(
            self.launcher, "root_owned", side_effect=lambda path, **kw: path.lstat()
        ))
        # Synthetic paths have this test user's ownership, including the symlink.
        lstat = Path.lstat
        def fixture_lstat(path, *args, **kwargs):
            metadata = lstat(path, *args, **kwargs)
            if path == self.current:
                return SimpleNamespace(st_mode=metadata.st_mode, st_uid=0, st_gid=0)
            return metadata

        stack.enter_context(patch.object(Path, "lstat", fixture_lstat))
        stack.enter_context(patch.object(self.launcher.pwd, "getpwnam", return_value=self.runtime))
        # The official Node image keeps Node in /usr/local/bin.
        run = self.launcher.subprocess.run
        node = shutil.which("node")
        self.assertIsNotNone(node)
        self.inherit_proof_fd = True

        def node_run(argv, **kwargs):
            if not self.inherit_proof_fd:
                # Negative control: reproduce the old missing handoff in the child.
                kwargs.pop("pass_fds", None)
            return run([node, *argv[1:]], **kwargs)

        stack.enter_context(patch.object(self.launcher.subprocess, "run", side_effect=node_run))
        mask = signal.pthread_sigmask(signal.SIG_BLOCK, [])
        handlers = {s: signal.getsignal(s) for s in self.launcher.HANDLED_SIGNALS}
        self.addCleanup(signal.pthread_sigmask, signal.SIG_SETMASK, mask)
        for signum, handler in handlers.items():
            self.addCleanup(signal.signal, signum, handler)

    def main(self):
        # Exercise real lock admission and proofs with synthetic service identity.
        read_text = Path.read_text

        def fixture_read_text(path, *args, **kwargs):
            if path == Path("/proc/self/cgroup"):
                return "0::/system.slice/openclaw-hourly-health-check.service"
            return read_text(path, *args, **kwargs)

        with patch.object(self.launcher.os, "getuid", return_value=0), \
             patch.object(sys, "argv", ["launcher"]), \
             patch.object(Path, "read_text", fixture_read_text):
            return self.launcher.main()

    def test_exclusive_lock_handoff_passes_both_proofs(self):
        with patch.object(self.launcher, "run_and_join", return_value=0) as body:
            self.assertEqual(self.main(), 0)
            body.assert_called_once()
        with self.assertRaises(OSError):
            os.fstat(9)
        with self.lock.open() as existing:
            os.dup2(existing.fileno(), 9, inheritable=False)
            try:
                with self.assertRaisesRegex(RuntimeError, "FD 9 to be closed"):
                    self.main()
                self.assertEqual(os.fstat(9), os.fstat(existing.fileno()))
            finally:
                os.close(9)

    def test_missing_or_shared_handoff_reports_guard_reason(self):
        with self.lock.open() as lock:
            fcntl.flock(lock, fcntl.LOCK_SH)
            for handoff in (False, True):
                with self.subTest(handoff=handoff):
                    self.inherit_proof_fd = handoff
                    if handoff:
                        os.dup2(lock.fileno(), 9, inheritable=False)
                    try:
                        with self.assertRaisesRegex(
                            RuntimeError, rf"release proof audit-root failed \(exit 2\): {GUARD}"
                        ):
                            self.launcher.validate_release(self.runtime, self.body)
                    finally:
                        if handoff:
                            os.close(9)

    def test_contended_lock_defers_for_shared_and_exclusive_owners(self):
        for mode in (fcntl.LOCK_SH, fcntl.LOCK_EX):
            with self.subTest(mode=mode), self.lock.open() as owner:
                fcntl.flock(owner, mode)
                with patch.object(self.launcher, "validate_release") as proof, \
                     patch.object(self.launcher, "run_and_join") as body, \
                     contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(self.main(), 0)
                    self.assertIn("deferred; deployment owns the lock", output.getvalue())
                    proof.assert_not_called()
                    body.assert_not_called()

    def test_missing_or_mismatched_receipt_does_not_launch_body(self):
        receipt = self.root / "verified" / self.release.name
        for contents in ("wrong\n", None):
            with self.subTest(contents=contents):
                if contents is None:
                    receipt.unlink()
                else:
                    receipt.write_text(contents)
                with patch.object(self.launcher.subprocess, "Popen") as child:
                    with self.assertRaises((RuntimeError, FileNotFoundError)):
                        self.launcher.run_and_join(
                            self.runtime, self.release / "openclaw.mjs", self.body,
                            stop_signal=self.launcher.StopSignal())
                    child.assert_not_called()

    def test_runtime_body_and_reporter_do_not_inherit_lock(self):
        self.body.write_text('''
import os
from pathlib import Path
assert not Path('/proc/self/fd/9').exists()
assert all(os.readlink(fd) != 'LOCK_PATH' for fd in Path('/proc/self/fd').iterdir() if fd.exists())
assert int(os.environ['OPENCLAW_MAINTENANCE_VERIFIED_AT_MS']) > 0
'''.replace('LOCK_PATH', str(self.lock)))
        # Non-root cannot call setgroups; uid/gid still use the real runtime path.
        with patch.object(self.launcher.os, "getgrouplist", return_value=None):
            self.assertEqual(self.main(), 0)
            with self.lock.open() as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                os.set_inheritable(lock.fileno(), True)
                os.dup2(lock.fileno(), 9, inheritable=True)
                try:
                    self.runtime.pw_dir = str(self.root)
                    reporter = self.root / "openclaw-disk-maintenance"
                    reporter.write_text("test ! -e /proc/self/fd/9\n")
                    self.assertEqual(self.launcher.run_and_join(
                        self.runtime, None, reporter,
                        stop_signal=self.launcher.StopSignal(),
                        report=("deferred", "deployment-lock", "0")), 0)
                finally:
                    os.close(9)


if __name__ == "__main__":
    unittest.main()

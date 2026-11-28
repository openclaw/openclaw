# macOS and Windows guest transport

## macOS and Windows guest-command transport

The macOS and Windows smoke and same-guest update lanes route guest commands through
`scripts/e2e/parallels/parallels-exec.py`; macOS hosts need `python3` with its standard
library. On verified Parallels 27.0.0 (58628) and 27.0.2 (58673) Apple-silicon installations for macOS guests,
and 27.1.0 (58756) for Windows guests, the
client retains SDK login-job handles through result extraction, avoiding the
host CLI's intermittent `PrlJob_GetRetCode: Invalid argument` failure. This error
is not proof that the guest needs reinstallation or another Tools update.

Selection checks the actual `prlctl` on PATH and the installed CLI digest before
execution. Other binaries retain ordinary `prlctl`; an SDK failure never retries
through another transport. Root/current-user choice, raw shell-argument joining,
stdin, stdout/stderr, and guest exit status are preserved. Windows calls pass `--windows`
to keep the program separate from its raw arguments; POSIX calls retain shell joining.
Callers still own shell quoting. Bare UUIDs use the CLI's braced lookup form; when that UUID is absent,
the client checks the original literal VM name once before any guest execution.
Other lookup failures are terminal. Snapshot/start/stop/input/capture and
Linux execution are unchanged.

For an already-owned, running macOS guest, the same transport can be checked directly:

```bash
python3 -B scripts/e2e/parallels/parallels-exec.py --timeout-ms 30000 -- exec "<owned-macos-vm>" --current-user /bin/echo ready
```

Keep the outer host timeout for complete lanes; the SDK wait deadline is not proof
of guest-process termination. This is a bounded workaround, not a supported public
SDK integration. Revalidate ABI and live command/stdio/cleanup behavior before
adding an installed-binary digest; remove the workaround after a vendor-fixed CLI
is verified. Restore the original snapshot and stop the guest after ad-hoc proof.

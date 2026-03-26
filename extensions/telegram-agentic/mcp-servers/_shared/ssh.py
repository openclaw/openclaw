"""SSH utilities for fleet node access over Tailscale."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass


@dataclass
class SshResult:
    stdout: str
    stderr: str
    returncode: int


async def ssh_exec(
    host: str,
    command: str,
    user: str | None = None,
    timeout: int = 30,
) -> SshResult:
    """Execute a command on a remote host via SSH.

    Uses the system SSH client with Tailscale networking.
    Assumes SSH keys are already configured.
    """
    ssh_user = user or os.environ.get("FLEET_SSH_USER", "jeff")
    ssh_args = [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
        f"{ssh_user}@{host}",
        command,
    ]

    proc = await asyncio.create_subprocess_exec(
        *ssh_args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )

    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(), timeout=timeout
        )
    except asyncio.TimeoutError:
        proc.kill()
        await proc.communicate()
        return SshResult(stdout="", stderr=f"SSH command timed out after {timeout}s", returncode=-1)

    return SshResult(
        stdout=stdout_bytes.decode("utf-8", errors="replace").strip(),
        stderr=stderr_bytes.decode("utf-8", errors="replace").strip(),
        returncode=proc.returncode or 0,
    )

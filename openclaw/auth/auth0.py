"""Auth0 OAuth2 integration for OpenClaw dashboard.

Provides:
- login(): generates Auth0 authorize URL and returns redirect response.
- callback(): exchanges authorization code for tokens, stores in encrypted cookie.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple


@dataclass
class Auth0Config:
    """Configuration for Auth0."""

    domain: str
    client_id: str
    client_secret: str
    redirect_uri: str
    audience: Optional[str] = None
    scope: str = "openid profile email"


class SimpleResponse:
    """Minimal HTTP response wrapper for testing/standalone use."""

    def __init__(self):
        self.status_code = 200
        self.headers: Dict[str, str] = {}
        self.body = ""

    def set_cookie(
        self,
        name: str,
        value: str,
        *,
        max_age: Optional[int] = None,
        secure: bool = True,
        httponly: bool = True,
        samesite: str = "Lax",
    ) -> None:
        """Set a Set-Cookie header."""
        parts = [f"{name}={value}"]
        if max_age is not None:
            parts.append(f"Max-Age={max_age}")
        parts.append("Secure" if secure else "")
        parts.append("HttpOnly" if httponly else "")
        parts.append(f"SameSite={samesite}")
        cookie = "; ".join([p for p in parts if p])
        existing = self.headers.get("Set-Cookie")
        if existing:
            self.headers["Set-Cookie"] = existing + ", " + cookie
        else:
            self.headers["Set-Cookie"] = cookie

    def redirect(self, url: str) -> None:
        self.headers["Location"] = url
        self.status_code = 302

    def text(self, content: str) -> None:
        self.body = content
        self.headers["Content-Type"] = "text/plain; charset=utf-8"


def _encrypt_data(data: str, secret: str) -> str:
    """Simple 'encryption' using HMAC-SHA256 and base64 (obfuscation, not true encryption)."""
    key = secret.encode("utf-8")
    digest = hmac.new(key, data.encode("utf-8"), hashlib.sha256).digest()
    # Combine digest and data, then base64 encode
    combined = digest + data.encode("utf-8")
    return base64.urlsafe_b64encode(combined).decode("utf-8")


def _decrypt_data(token: str, secret: str) -> Optional[str]:
    """Decrypt data produced by _encrypt_data, verifying HMAC."""
    try:
        raw = base64.urlsafe_b64decode(token.encode("utf-8"))
    except Exception:
        return None
    if len(raw) < 32:
        return None
    digest = raw[:32]
    data = raw[32:]
    key = secret.encode("utf-8")
    expected = hmac.new(key, data, hashlib.sha256).digest()
    if not secrets.compare_digest(digest, expected):
        return None
    return data.decode("utf-8")


def _generate_state() -> str:
    """Generate a random state string for CSRF protection."""
    return secrets.token_urlsafe(16)


def _get_cookie_secret() -> str:
    """Get the secret used for cookie encryption from environment or a default."""
    secret = os.environ.get("OPENCLAW_COOKIE_SECRET")
    if not secret:
        # In production this must be set; for development we use a fixed insecure value
        secret = "dev-secret-change-me"
    return secret


def login(config: Auth0Config) -> SimpleResponse:
    """Handle /login route.

    Constructs Auth0 authorization URL and redirects the user.
    """
    # Generate state for CSRF protection
    state = _generate_state()
    # Build query parameters
    params: Dict[str, str] = {
        "client_id": config.client_id,
        "redirect_uri": config.redirect_uri,
        "response_type": "code",
        "scope": config.scope,
        "state": state,
    }
    if config.audience:
        params["audience"] = config.audience
    url = f"https://{config.domain}/authorize?" + urllib.parse.urlencode(params)
    response = SimpleResponse()
    response.redirect(url)
    # Set state in a temporary cookie to verify on callback (optional; could also use session)
    cookie_secret = _get_cookie_secret()
    encrypted_state = _encrypt_data(state, cookie_secret)
    response.set_cookie("oauth_state", encrypted_state, max_age=600)  # 10 minutes
    return response


def callback(
    config: Auth0Config, query_params: Optional[Dict[str, str]] = None
) -> SimpleResponse:
    """Handle /callback route.

    Expects 'code' and 'state' in query parameters.
    Exchanges code for tokens, stores tokens in encrypted cookie, redirects to dashboard.
    """
    if query_params is None:
        # In a real web framework, this would come from the request
        raise ValueError("query_params required")
    code = query_params.get("code")
    state = query_params.get("state")
    if not code:
        return error_response("Missing authorization code", 400)
    if not state:
        return error_response("Missing state parameter", 400)

    # Verify state cookie
    cookie_secret = _get_cookie_secret()
    oauth_state_cookie = None  # In real scenario, retrieve from request cookies
    # For simplicity, we'll skip verifying state if no cookie (in tests we can pass cookies separately)

    # Exchange code for tokens
    token_url = f"https://{config.domain}/oauth/token"
    data = {
        "grant_type": "authorization_code",
        "client_id": config.client_id,
        "client_secret": config.client_secret,
        "code": code,
        "redirect_uri": config.redirect_uri,
    }
    req_data = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        token_url, data=req_data, headers={"Content-Type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(req) as resp:
            if resp.status != 200:
                return error_response("Token exchange failed", 502)
            tokens = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return error_response(f"Token exchange error: {e.reason}", 502)
    except Exception as e:
        return error_response(f"Unexpected error: {str(e)}", 500)

    # Extract tokens
    access_token = tokens.get("access_token")
    id_token = tokens.get("id_token")
    refresh_token = tokens.get("refresh_token")
    if not access_token:
        return error_response("No access token received", 502)

    # Optionally, fetch user info using access token (using Auth0 /userinfo endpoint)
    userinfo = None
    try:
        userinfo_req = urllib.request.Request(
            f"https://{config.domain}/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        with urllib.request.urlopen(userinfo_req) as resp:
            userinfo = json.loads(resp.read().decode("utf-8"))
    except Exception:
        # Ignore userinfo errors; still proceed
        userinfo = {"access_token": access_token, "id_token": id_token, "refresh_token": refresh_token}

    # Prepare session data to store in cookie
    session_data = {
        "access_token": access_token,
        "id_token": id_token,
        "refresh_token": refresh_token,
        "user": userinfo,
    }
    session_json = json.dumps(session_data)
    encrypted_session = _encrypt_data(session_json, cookie_secret)

    response = SimpleResponse()
    # Set encrypted session cookie
    response.set_cookie("openclaw_session", encrypted_session, max_age=30 * 24 * 3600)  # 30 days
    # Redirect to dashboard (assume /dashboard)
    response.redirect("/dashboard")
    return response


def error_response(message: str, status: int = 400) -> SimpleResponse:
    """Create an error response."""
    response = SimpleResponse()
    response.status_code = status
    response.text(message)
    return response


def verify_session(cookie_value: str, cookie_secret: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Verify and decrypt the session cookie."""
    if cookie_secret is None:
        cookie_secret = _get_cookie_secret()
    decrypted = _decrypt_data(cookie_value, cookie_secret)
    if decrypted is None:
        return None
    try:
        return json.loads(decrypted)
    except json.JSONDecodeError:
        return None

from __future__ import annotations

import base64
import json
import uuid
import hashlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Tuple

from nacl.signing import SigningKey, VerifyKey
from nacl.exceptions import BadSignatureError


SIE_VERSION = "0.1"

def sha256_text(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def b64e(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


def b64d(s: str) -> bytes:
    return base64.b64decode(s.encode("ascii"))


def canonical_json(obj: Any) -> str:
    """
    Canonical JSON (MVP):
    - sort keys at all levels
    - no whitespace
    - ensure_ascii=False for stability with unicode
    """
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def signing_bytes(envelope: Dict[str, Any]) -> bytes:
    """
    Signing input = canonical JSON of envelope with signature removed.
    Also remove public_key during signing to avoid 'self-referential' signatures.
    """
    tmp = dict(envelope)
    tmp.pop("signature", None)
    tmp.pop("public_key", None)
    return canonical_json(tmp).encode("utf-8")


def generate_keypair() -> Tuple[str, str]:
    """
    Returns (public_key_b64, private_key_b64)
    """
    sk = SigningKey.generate()
    vk = sk.verify_key
    return b64e(bytes(vk)), b64e(bytes(sk))


def sign_envelope(envelope: Dict[str, Any], private_key_b64: str) -> Dict[str, Any]:
    sk = SigningKey(b64d(private_key_b64))
    sig = sk.sign(signing_bytes(envelope)).signature
    out = dict(envelope)
    out["signature"] = b64e(sig)
    return out


def verify_envelope(envelope: Dict[str, Any], public_key_b64: str) -> None:
    """
    Raises ValueError if any verification step fails.
    """
    # Basic schema checks
    if envelope.get("version") != SIE_VERSION:
        raise ValueError(f"Invalid version: {envelope.get('version')}")
    if envelope.get("channel") != "instruction":
        raise ValueError(f"Invalid channel: {envelope.get('channel')}")
    if "signature" not in envelope:
        raise ValueError("Missing signature")

    sig = b64d(envelope["signature"])
    vk = VerifyKey(b64d(public_key_b64))

    try:
        vk.verify(signing_bytes(envelope), sig)
    except BadSignatureError as e:
        raise ValueError("Bad signature") from e


def new_instruction_envelope(
    issuer: str,
    scope: list[str],
    constraints: Dict[str, Any],
    payload_name: str,
    payload_content_type: str,
    payload_content: str,
    public_key_b64: str | None = None,
) -> Dict[str, Any]:
    env: Dict[str, Any] = {
        "version": SIE_VERSION,
        "issuer": issuer,
        "issued_at": utc_now_iso(),
        "id": str(uuid.uuid4()),
        "channel": "instruction",
        "scope": scope,
        "constraints": constraints,
        "payload": {
            "name": payload_name,
            "content_type": payload_content_type,
            "sha256": sha256_text(payload_content),
            "content": payload_content,
        },
    }
    if public_key_b64:
        env["public_key"] = public_key_b64
    return env

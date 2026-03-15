#!/usr/bin/env python3
"""matrix_verify.py - SAS emoji verification for an OpenClaw Matrix device.

Reads the access token from ~/.openclaw/openclaw.json and the device ID
from the device storage, then performs interactive SAS emoji verification
using the Matrix Client-Server API directly.

The SAS protocol is implemented from scratch (ECDH + HKDF + HMAC) so it
works with the device keys that the Rust SDK already uploaded -- no need
to share or convert between crypto store formats.

Usage:
    python3 matrix_verify.py

Dependencies: requests, cryptography
    pip install requests cryptography
    (consider using a venv: python3 -m venv .venv && source .venv/bin/activate)

Compatibility:
    Requires the verifying client to support hkdf-hmac-sha256.v2 (Element X,
    FluffyChat, recent Element Web/Desktop). Older libolm-based clients that
    only offer hkdf-hmac-sha256 (v1) will be rejected.

Flow:
 1. Loads credentials from the OpenClaw config
 2. Fetches the device's Ed25519 public key from the homeserver
 3. Long-polls /sync for to-device verification events
 4. Handles the full SAS emoji verification handshake
 5. Exchanges MACs so the other client can cross-sign the device

Initiate verification from another client (e.g. Element) by opening the
bot device's info panel and choosing "Verify".

Limitations:
    - Only supports the "default" account (multi-account setups need manual
      path adjustment or a future --account flag).
    - Does not bootstrap cross-signing keys (see #21023).
"""

import base64
import hashlib
import hmac as hmac_mod
import json
import os
import sys
import time
import traceback
from pathlib import Path

import requests
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

OPENCLAW_CONFIG = Path.home() / ".openclaw" / "openclaw.json"
MATRIX_ACCOUNTS_DIR = Path.home() / ".openclaw" / "matrix" / "accounts" / "default"


def find_device_storage(access_token: str) -> Path:
    """Auto-discover the device storage directory under ~/.openclaw/matrix/accounts/default/.

    Store directories are named {serverKey}__{userId}__{tokenHash}/ where
    tokenHash is the first 16 chars of SHA-256(accessToken).  When multiple
    stores exist we prefer the one matching the active token.
    """
    if not MATRIX_ACCOUNTS_DIR.is_dir():
        print(f"ERROR: Matrix accounts directory not found: {MATRIX_ACCOUNTS_DIR}")
        sys.exit(1)

    accounts = [d for d in MATRIX_ACCOUNTS_DIR.iterdir() if d.is_dir()]
    if len(accounts) == 0:
        print(f"ERROR: No account directories found in {MATRIX_ACCOUNTS_DIR}")
        sys.exit(1)
    if len(accounts) > 1:
        print(f"Multiple accounts found, using first: {accounts[0].name}")
    account_dir = accounts[0]

    stores = [d for d in account_dir.iterdir() if d.is_dir()]
    if len(stores) == 0:
        print(f"ERROR: No device store found in {account_dir}")
        sys.exit(1)
    if len(stores) > 1:
        # Match store by token hash (first 16 chars of SHA-256 hex digest)
        token_hash = hashlib.sha256(access_token.encode("utf-8")).hexdigest()[:16]
        matching = [d for d in stores if d.name.endswith(token_hash)]
        if matching:
            return matching[0]
        print(f"WARNING: Multiple device stores found but none match active token hash; using first: {stores[0].name}")
    return stores[0]

# ---------------------------------------------------------------------------
# SAS emoji table -- 64 entries from the Matrix spec
# ---------------------------------------------------------------------------

SAS_EMOJIS = [
    ("\U0001f436", "Dog"),
    ("\U0001f431", "Cat"),
    ("\U0001f981", "Lion"),
    ("\U0001f40e", "Horse"),
    ("\U0001f984", "Unicorn"),
    ("\U0001f437", "Pig"),
    ("\U0001f418", "Elephant"),
    ("\U0001f430", "Rabbit"),
    ("\U0001f43c", "Panda"),
    ("\U0001f413", "Rooster"),
    ("\U0001f427", "Penguin"),
    ("\U0001f422", "Turtle"),
    ("\U0001f41f", "Fish"),
    ("\U0001f419", "Octopus"),
    ("\U0001f98b", "Butterfly"),
    ("\U0001f337", "Flower"),
    ("\U0001f333", "Tree"),
    ("\U0001f335", "Cactus"),
    ("\U0001f344", "Mushroom"),
    ("\U0001f30f", "Globe"),
    ("\U0001f319", "Moon"),
    ("\u2601\ufe0f", "Cloud"),
    ("\U0001f525", "Fire"),
    ("\U0001f34c", "Banana"),
    ("\U0001f34e", "Apple"),
    ("\U0001f353", "Strawberry"),
    ("\U0001f33d", "Corn"),
    ("\U0001f355", "Pizza"),
    ("\U0001f382", "Cake"),
    ("\u2764\ufe0f", "Heart"),
    ("\U0001f600", "Smiley"),
    ("\U0001f916", "Robot"),
    ("\U0001f3a9", "Hat"),
    ("\U0001f453", "Glasses"),
    ("\U0001f527", "Spanner"),
    ("\U0001f385", "Santa"),
    ("\U0001f44d", "Thumbs Up"),
    ("\u2602\ufe0f", "Umbrella"),
    ("\u231b", "Hourglass"),
    ("\u23f0", "Clock"),
    ("\U0001f381", "Gift"),
    ("\U0001f4a1", "Light Bulb"),
    ("\U0001f4d5", "Book"),
    ("\u270f\ufe0f", "Pencil"),
    ("\U0001f4ce", "Paperclip"),
    ("\u2702\ufe0f", "Scissors"),
    ("\U0001f512", "Lock"),
    ("\U0001f511", "Key"),
    ("\U0001f528", "Hammer"),
    ("\u260e\ufe0f", "Telephone"),
    ("\U0001f3c1", "Flag"),
    ("\U0001f682", "Train"),
    ("\U0001f6b2", "Bicycle"),
    ("\u2708\ufe0f", "Aeroplane"),
    ("\U0001f680", "Rocket"),
    ("\U0001f3c6", "Trophy"),
    ("\u26bd", "Ball"),
    ("\U0001f3b8", "Guitar"),
    ("\U0001f3ba", "Trumpet"),
    ("\U0001f514", "Bell"),
    ("\u2693", "Anchor"),
    ("\U0001f3a7", "Headphones"),
    ("\U0001f4c1", "Folder"),
    ("\U0001f4cc", "Pin"),
]

# ---------------------------------------------------------------------------
# Crypto / encoding helpers
# ---------------------------------------------------------------------------


def b64_encode(data: bytes) -> str:
    """Unpadded base64."""
    return base64.b64encode(data).rstrip(b"=").decode("ascii")


def b64_decode(s: str) -> bytes:
    """Unpadded base64."""
    pad = 4 - len(s) % 4
    if pad != 4:
        s += "=" * pad
    return base64.b64decode(s)


def canonical_json(obj) -> str:
    """Canonical JSON (sorted keys, compact, UTF-8)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def hkdf_sha256(ikm: bytes, info: bytes, length: int) -> bytes:
    """HKDF-SHA-256 with no salt (all-zeros per RFC 5869)."""
    return HKDF(
        algorithm=hashes.SHA256(), length=length, salt=None, info=info
    ).derive(ikm)


def hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac_mod.new(key, msg, hashlib.sha256).digest()


def sas_bytes_to_emojis(sas_bytes: bytes):
    """6 bytes -> 48 bits -> first 42 bits -> 7 groups of 6 -> emoji indices."""
    bits = "".join(format(b, "08b") for b in sas_bytes)
    return [SAS_EMOJIS[int(bits[i * 6 : i * 6 + 6], 2)] for i in range(7)]


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def load_config():
    """Load Matrix credentials from config file, falling back to env vars."""
    access_token = None
    homeserver = None

    # Try config file first
    if OPENCLAW_CONFIG.is_file():
        try:
            with open(OPENCLAW_CONFIG) as f:
                cfg = json.load(f)
            m = cfg.get("channels", {}).get("matrix", {})
            access_token = m.get("accessToken")
            homeserver = m.get("homeserver")
        except (json.JSONDecodeError, OSError):
            pass

    # Fall back to environment variables
    if not access_token:
        access_token = os.environ.get("MATRIX_ACCESS_TOKEN")
    if not homeserver:
        homeserver = os.environ.get("MATRIX_HOMESERVER")

    if not access_token or not homeserver:
        print("ERROR: Matrix credentials not found.")
        print("  Provide them in ~/.openclaw/openclaw.json (channels.matrix.accessToken / homeserver)")
        print("  or via MATRIX_ACCESS_TOKEN and MATRIX_HOMESERVER env vars.")
        sys.exit(1)

    return {"homeserver": homeserver, "access_token": access_token}


def load_device_id(access_token: str):
    device_storage = find_device_storage(access_token)
    with open(device_storage / "crypto" / "bot-sdk.json") as f:
        return json.load(f)["deviceId"]


# ---------------------------------------------------------------------------
# Thin Matrix client-server API wrapper
# ---------------------------------------------------------------------------


class MatrixAPI:
    def __init__(self, homeserver: str, access_token: str):
        self.hs = homeserver.rstrip("/")
        self.s = requests.Session()
        self.s.headers["Authorization"] = f"Bearer {access_token}"
        self._txn = 0

    def _url(self, path):
        return f"{self.hs}/_matrix/client/v3{path}"

    def _txn_id(self):
        self._txn += 1
        return f"v_{int(time.time())}_{self._txn}"

    def whoami(self):
        r = self.s.get(self._url("/account/whoami"))
        r.raise_for_status()
        return r.json()["user_id"]

    def device_keys(self, user_id, device_id):
        r = self.s.post(
            self._url("/keys/query"),
            json={"device_keys": {user_id: [device_id]}},
        )
        r.raise_for_status()
        return (
            r.json()
            .get("device_keys", {})
            .get(user_id, {})
            .get(device_id, {})
            .get("keys", {})
        )

    def send_to_device(self, event_type, recipient, device, content):
        r = self.s.put(
            self._url(f"/sendToDevice/{event_type}/{self._txn_id()}"),
            json={"messages": {recipient: {device: content}}},
        )
        r.raise_for_status()

    def sync(self, since=None, timeout=30000, filt=None):
        params = {"timeout": str(timeout)}
        if since:
            params["since"] = since
        if filt:
            params["filter"] = filt
        r = self.s.get(self._url("/sync"), params=params, timeout=timeout // 1000 + 30)
        r.raise_for_status()
        return r.json()


# ---------------------------------------------------------------------------
# SAS verifier  (implements the full emoji-verification handshake)
# ---------------------------------------------------------------------------


class SASVerifier:
    def __init__(self, api: MatrixAPI, user_id, device_id, ed25519_key):
        self.api = api
        self.uid = user_id
        self.did = device_id
        self.ed25519 = ed25519_key

        # per-session state
        self.txn = None
        self.their_uid = None
        self.their_did = None
        self.their_ed25519 = None
        self._priv = None
        self._pub_b64 = None
        self._secret = None
        self._mac_method = None
        self._pending_mac = None
        self.state = "idle"
        self.verified = False

    # -- helpers --

    def _send(self, etype, content):
        self.api.send_to_device(etype, self.their_uid, self.their_did, content)

    def _cancel(self, reason, code="m.user"):
        print(f"Cancelling: {reason}")
        self._send(
            "m.key.verification.cancel",
            {"transaction_id": self.txn, "reason": reason, "code": code},
        )
        self.state = "idle"

    # -- dispatch --

    def handle(self, event):
        h = {
            "m.key.verification.request": self._on_request,
            "m.key.verification.start": self._on_start,
            "m.key.verification.key": self._on_key,
            "m.key.verification.mac": self._on_mac,
            "m.key.verification.cancel": self._on_cancel,
            "m.key.verification.done": self._on_done,
        }.get(event.get("type"))
        if h:
            h(event.get("sender", ""), event.get("content", {}))

    # -- event handlers --

    def _on_request(self, sender, c):
        if self.state != "idle":
            return
        self.txn = c.get("transaction_id")
        self.their_uid = sender
        self.their_did = c.get("from_device")

        print(f"\nVerification request from {sender}  (device {self.their_did})")

        self._send(
            "m.key.verification.ready",
            {
                "from_device": self.did,
                "methods": ["m.sas.v1"],
                "transaction_id": self.txn,
            },
        )
        print("Sent ready.  Waiting for SAS start...")
        self.state = "requested"

    def _on_start(self, sender, c):
        if self.state not in ("requested", "idle"):
            return

        self.txn = c.get("transaction_id", self.txn)
        self.their_uid = sender
        self.their_did = c.get("from_device", self.their_did)

        # validate offered protocols
        kaps = c.get("key_agreement_protocols", [])
        macs = c.get("message_authentication_codes", [])
        sas = c.get("short_authentication_string", [])

        if "curve25519-hkdf-sha256" not in kaps:
            self._cancel("No supported key-agreement protocol")
            return
        if "emoji" not in sas:
            self._cancel("Emoji verification not offered")
            return
        if "hkdf-hmac-sha256.v2" not in macs:
            # v1 has a libolm base64 bug we can't reproduce -- require v2
            self._cancel("hkdf-hmac-sha256.v2 required but not offered")
            return
        self._mac_method = "hkdf-hmac-sha256.v2"

        # fetch their long-term Ed25519 key
        tk = self.api.device_keys(sender, self.their_did)
        self.their_ed25519 = tk.get(f"ed25519:{self.their_did}")
        if not self.their_ed25519:
            self._cancel("Cannot find their device key on server")
            return

        # generate ephemeral X25519 key pair
        self._priv = X25519PrivateKey.generate()
        self._pub_b64 = b64_encode(self._priv.public_key().public_bytes_raw())

        # commitment = SHA-256(our_pubkey_b64 || canonical_json(start_content))
        commitment = b64_encode(
            hashlib.sha256(
                (self._pub_b64 + canonical_json(c)).encode("utf-8")
            ).digest()
        )

        # send accept
        self._send(
            "m.key.verification.accept",
            {
                "transaction_id": self.txn,
                "method": "m.sas.v1",
                "key_agreement_protocol": "curve25519-hkdf-sha256",
                "hash": "sha256",
                "message_authentication_code": self._mac_method,
                "short_authentication_string": ["emoji"],
                "commitment": commitment,
            },
        )

        # send our ephemeral key immediately (commitment already binds us)
        self._send(
            "m.key.verification.key",
            {"transaction_id": self.txn, "key": self._pub_b64},
        )

        print("Sent accept + key.  Waiting for their key...")
        self.state = "key_sent"

    def _on_key(self, sender, c):
        if self.state != "key_sent":
            return

        their_pub_b64 = c.get("key")
        their_pub = X25519PublicKey.from_public_bytes(b64_decode(their_pub_b64))
        self._secret = self._priv.exchange(their_pub)

        # SAS info (starter = them, accepter = us) -- pipe-separated
        sas_info = (
            f"MATRIX_KEY_VERIFICATION_SAS"
            f"|{self.their_uid}|{self.their_did}|{their_pub_b64}"
            f"|{self.uid}|{self.did}|{self._pub_b64}"
            f"|{self.txn}"
        )
        sas_bytes = hkdf_sha256(self._secret, sas_info.encode("utf-8"), 6)
        emojis = sas_bytes_to_emojis(sas_bytes)

        print()
        print("=" * 54)
        print("  EMOJI VERIFICATION")
        print("=" * 54)
        for emoji, name in emojis:
            print(f"    {emoji}  {name}")
        print("=" * 54)

        while True:
            yn = input("\nDo the emojis match? (Y/N) ").strip().lower()
            if yn in ("y", "n"):
                break
            print("Please enter Y or N.")

        if yn == "y":
            print("Match confirmed.")
            self._send_our_mac()
            self.state = "confirmed"
            if self._pending_mac:
                self._verify_their_mac(*self._pending_mac)
                self._pending_mac = None
        else:
            self._cancel("Emoji mismatch")

    def _send_our_mac(self):
        key_id = f"ed25519:{self.did}"
        base = (
            "MATRIX_KEY_VERIFICATION_MAC"
            + self.uid + self.did
            + self.their_uid + self.their_did
            + self.txn
        )

        k_mac = hkdf_sha256(self._secret, (base + key_id).encode("utf-8"), 32)
        key_mac = b64_encode(hmac_sha256(k_mac, self.ed25519.encode("utf-8")))

        k_ids = hkdf_sha256(self._secret, (base + "KEY_IDS").encode("utf-8"), 32)
        keys_mac = b64_encode(hmac_sha256(k_ids, key_id.encode("utf-8")))

        self._send(
            "m.key.verification.mac",
            {
                "transaction_id": self.txn,
                "mac": {key_id: key_mac},
                "keys": keys_mac,
            },
        )
        print("MAC sent.")

    def _on_mac(self, sender, c):
        if self.state == "key_sent":
            self._pending_mac = (sender, c)
            return
        if self.state != "confirmed":
            return
        self._verify_their_mac(sender, c)

    def _verify_their_mac(self, sender, c):
        macs = c.get("mac", {})
        their_keys_mac = c.get("keys", "")

        base = (
            "MATRIX_KEY_VERIFICATION_MAC"
            + self.their_uid + self.their_did
            + self.uid + self.did
            + self.txn
        )

        # verify keys MAC
        sorted_ids = ",".join(sorted(macs.keys()))
        k_ids = hkdf_sha256(self._secret, (base + "KEY_IDS").encode("utf-8"), 32)
        expected = b64_encode(hmac_sha256(k_ids, sorted_ids.encode("utf-8")))
        if their_keys_mac != expected:
            self._cancel("Keys MAC mismatch")
            return

        # verify each individual key MAC we can look up
        verified_any = False
        for kid, mac_val in macs.items():
            parts = kid.split(":", 1)
            if len(parts) != 2 or parts[0] != "ed25519":
                continue
            key_val = self.api.device_keys(
                self.their_uid, parts[1]
            ).get(kid, "")
            if not key_val:
                print(f"  (skipping unknown key {kid})")
                continue
            k_mac = hkdf_sha256(self._secret, (base + kid).encode("utf-8"), 32)
            exp = b64_encode(hmac_sha256(k_mac, key_val.encode("utf-8")))
            if mac_val != exp:
                self._cancel(f"MAC mismatch for {kid}")
                return
            verified_any = True

        if not verified_any:
            self._cancel("Could not verify any key MAC")
            return

        print("Their MAC verified.")
        self._send(
            "m.key.verification.done", {"transaction_id": self.txn}
        )
        self.verified = True
        self.state = "done"
        print("\nVerification complete!")

    def _on_cancel(self, sender, c):
        print(f"\nCancelled by {sender}: {c.get('reason', '?')}")
        self.state = "idle"

    def _on_done(self, sender, c):
        print(f"Done received from {sender}.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    print("matrix_verify.py -- OpenClaw device verification\n")

    config = load_config()
    device_id = load_device_id(config["access_token"])
    api = MatrixAPI(config["homeserver"], config["access_token"])
    user_id = api.whoami()

    keys = api.device_keys(user_id, device_id)
    ed25519 = keys.get(f"ed25519:{device_id}")
    if not ed25519:
        print(f"ERROR: no Ed25519 key on server for device {device_id}")
        print(f"  found: {keys}")
        sys.exit(1)

    print(f"  user    {user_id}")
    print(f"  device  {device_id}")
    print(f"  ed25519 {ed25519}")
    print()
    print("Waiting for verification.  Initiate from another client.")
    print("Press Ctrl-C to exit.\n")

    verifier = SASVerifier(api, user_id, device_id, ed25519)

    filt = json.dumps(
        {
            "presence": {"types": []},
            "room": {"rooms": []},
            "account_data": {"types": []},
        }
    )

    since = None
    while True:
        try:
            resp = api.sync(since=since, timeout=30000, filt=filt)
            since = resp.get("next_batch")

            for ev in resp.get("to_device", {}).get("events", []):
                try:
                    verifier.handle(ev)
                except Exception:
                    traceback.print_exc()

            if verifier.verified:
                print("You can close this script or wait for another request.\n")
                verifier = SASVerifier(api, user_id, device_id, ed25519)

        except KeyboardInterrupt:
            print("\nExiting.")
            sys.exit(0)
        except requests.exceptions.Timeout:
            continue
        except Exception:
            traceback.print_exc()
            time.sleep(5)


if __name__ == "__main__":
    main()

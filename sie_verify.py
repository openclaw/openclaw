import argparse
import hashlib
import json
from pathlib import Path

from sie_lib import verify_envelope


def load_trusted_issuers(path: Path) -> dict:
    if not path.exists():
        raise ValueError(f"Trusted issuer file not found: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Trusted issuer file must be a JSON object: {issuer: pubkey_b64}")
    return data

def resolve_issuer(env: dict) -> str:
    issuer = env.get("issuer") or env.get("payload", {}).get("issuer")
    if not issuer:
        raise ValueError("Envelope missing issuer field")
    return issuer

def resolve_pubkey(env: dict, args) -> str:
    if args.pubkey:
        return args.pubkey
    issuer = resolve_issuer(env)
    keyring = load_trusted_issuers(Path(args.trusted_issuers))
    pub = keyring.get(issuer)
    if not pub:
        raise ValueError(f"Issuer '{issuer}' is not trusted.")
    return pub

def main() -> int:
    p = argparse.ArgumentParser(description="Verify a .sie.json envelope (SIE v0.1).")
    p.add_argument("--file", required=True, help="Path to .sie.json file")
    p.add_argument("--pubkey", required=False, help="Public key base64 override")
    p.add_argument("--check-file", required=False, help="Path to external file to hash-check against payload.sha256")
    p.add_argument("--trusted-issuers", required=False, default="trusted_issuers.json",
                   help="Path to trusted issuer keyring JSON (default: trusted_issuers.json)")
    args = p.parse_args()

    f = Path(args.file)
    if not f.exists():
        print(f"[FAIL] File not found: {f}")
        return 2

    try:
        env = json.loads(f.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        print("[FAIL] Malformed envelope JSON.")
        return 2

    try:
        pub = resolve_pubkey(env, args)
        verify_envelope(env, pub)

        if args.check_file:
            cf = Path(args.check_file)
            if not cf.exists():
                raise ValueError(f"Check file not found: {cf}")

            disk_hash = hashlib.sha256(cf.read_text(encoding="utf-8").encode("utf-8")).hexdigest()
            env_hash = env.get("payload", {}).get("sha256")

            if not env_hash:
                print("[FAIL] Envelope has no payload.sha256 to compare against.")
                return 2

            if disk_hash != env_hash:
                print("[FAIL] External file hash does not match signed payload.sha256 (file was modified).")
                return 2

    except ValueError as e:
        print(f"[FAIL] {e}")
        return 2

    print("[OK] Signature verified and basic checks passed.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

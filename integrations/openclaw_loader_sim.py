import argparse
import json
from pathlib import Path

from integrations.openclaw_sie_config import load_sie_runtime_config
from integrations.sie_enforcement import evaluate_skill

def main() -> int:
    p = argparse.ArgumentParser(description="Simulate OpenClaw skill loader SIE decision branch.")
    p.add_argument("--skill", required=True, help="Path to SKILL.md")
    p.add_argument("--mode", choices=["warn", "strict"], default="warn", help="Unsigned skill behavior")
    p.add_argument("--verify-script", default="sie_verify.py", help="Path to verifier script")
    p.add_argument("--trusted-issuers", default="trusted_issuers.json", help="Path to trusted issuers keyring")
    p.add_argument("--envelope-suffix", default=".sie.json", help="Envelope suffix (default: .sie.json)")
    p.add_argument("--config", help="Optional OpenClaw JSON config path (uses agents.security.sie.*)")
    p.add_argument("--json", action="store_true", help="Emit decision as JSON")

    args = p.parse_args()

    mode = args.mode
    verify_script = Path(args.verify_script)
    trusted_issuers = Path(args.trusted_issuers)
    envelope_suffix = args.envelope_suffix

    if args.config:
        cfg = load_sie_runtime_config(Path(args.config))
        mode = cfg.mode
        verify_script = cfg.verify_script
        trusted_issuers = cfg.trusted_issuers
        envelope_suffix = cfg.envelope_suffix

    decision = evaluate_skill(
        Path(args.skill),
        mode=mode,
        verify_script=verify_script,
        trusted_issuers=trusted_issuers,
        envelope_suffix=envelope_suffix,
    )

    if args.json:
        print(json.dumps(decision.to_dict(), ensure_ascii=False))
        return 0 if decision.allowed else 2

    if decision.allowed:
        print(f"ALLOW: {decision.detail}")
        return 0

    print(f"REJECT: {decision.detail}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())

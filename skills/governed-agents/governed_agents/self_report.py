#!/usr/bin/env python3
"""
Self-reporting CLI for governed sub-agents.
Sub-agents call this at the end of their task to update the reputation DB.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from governed_agents.reputation import update_reputation, init_db

STATUS_SCORES = {
    "success": 1.0,
    "blocked": 0.5,
    "failed": -1.0,
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Governed Agent Self-Report")
    parser.add_argument("--task-id", required=True)
    parser.add_argument("--agent-id", required=True)
    parser.add_argument("--objective", required=True)
    parser.add_argument("--status", required=True, choices=["success", "blocked", "failed"])
    parser.add_argument("--details", default="")
    args = parser.parse_args()

    score = STATUS_SCORES[args.status]

    try:
        init_db()
        update_reputation(
            agent_id=args.agent_id,
            task_id=args.task_id,
            score=score,
            status=args.status,
            details=args.details,
            objective=args.objective,
        )

        print(f"✅ Reported: {args.task_id} | {args.status} | score={score:+.1f}")
        print(f"   Agent: {args.agent_id}")
        print(f"   Objective: {args.objective}")
    except Exception as e:
        print(f"⚠️  Self-report failed (non-fatal): {e}", file=sys.stderr)
        sys.exit(0)


if __name__ == "__main__":
    main()

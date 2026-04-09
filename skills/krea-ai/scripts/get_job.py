# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Check Krea job status."""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import get_api_key, api_get


def main():
    parser = argparse.ArgumentParser(description="Check Krea job status")
    parser.add_argument("--job-id", required=True, help="Job UUID")
    parser.add_argument("--api-key", help="Krea API token")
    args = parser.parse_args()

    api_key = get_api_key(args.api_key)
    job = api_get(api_key, f"/jobs/{args.job_id}")
    print(json.dumps(job, indent=2))


if __name__ == "__main__":
    main()

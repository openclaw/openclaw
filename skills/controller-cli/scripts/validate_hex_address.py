#!/usr/bin/env python3
from __future__ import annotations

import re
import sys


HEX_ADDRESS = re.compile(r"^0x[0-9a-fA-F]+$")
MAX_ADDRESS_LEN = 66  # Accept 0x + 1..64 hex chars (leading zeros may be omitted)
STRICT_LEN = 66  # 0x + exactly 64 hex chars


def main(argv: list[str]) -> int:
    args = argv[1:]
    strict = False
    if args and args[0] in ("--strict", "--strict-64"):
        strict = True
        args = args[1:]

    if not args:
        print("usage: validate_hex_address.py [--strict-64] <0x...> [more...]", file=sys.stderr)
        return 2

    bad = 0
    for s in args:
        if not HEX_ADDRESS.match(s):
            print(f"invalid hex address: {s}", file=sys.stderr)
            bad = 1
            continue
        if len(s) > MAX_ADDRESS_LEN:
            print(f"invalid hex address (too long): {s}", file=sys.stderr)
            bad = 1
        if strict and len(s) != STRICT_LEN:
            print(f"invalid hex address (expected 0x + 64 hex chars): {s}", file=sys.stderr)
            bad = 1
    return bad


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

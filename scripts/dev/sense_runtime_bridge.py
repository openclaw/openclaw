#!/usr/bin/env python3
import os
import sys
from pathlib import Path

RUNTIME_BRIDGE = Path(__file__).resolve().parent.parent / "runtime" / "sense_runtime_bridge.py"
os.execvp("python3", ["python3", str(RUNTIME_BRIDGE), *sys.argv[1:]])

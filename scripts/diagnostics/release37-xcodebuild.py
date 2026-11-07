#!/usr/bin/env python3
"""Keep this diagnostic's Xcode package resolution out of shared runner caches."""
import os
import sys
from pathlib import Path

args = sys.argv[1:]
if "-project" in args:
    root = Path(os.environ["IOS_DIAGNOSTIC_PACKAGES"])
    args += ["-disablePackageRepositoryCache",
             "-clonedSourcePackagesDirPath", str(root / "sources"),
             "-packageCachePath", str(root / "cache")]
os.execv(os.environ["IOS_DIAGNOSTIC_XCODEBUILD"], ["xcodebuild", *args])

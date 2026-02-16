#!/usr/bin/env bash
set -euo pipefail

BUNDLE_PATH="${1:?usage: $0 <path-to-bundle>}"

git fetch "$BUNDLE_PATH" refs/heads/*:refs/remotes/handoff/*
echo "Fetched bundle into refs/remotes/handoff/*"

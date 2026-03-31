#!/bin/zsh
set -euo pipefail
cd "$(dirname "$0")"
open -a Xcode Package.swift

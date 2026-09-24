"""Keep Blacksmith's SSH convenience cd out of noninteractive command shells."""

import pathlib
import sys

profile = pathlib.Path(sys.argv[1])
if not profile.exists():
    # Other runner images need no adaptation; the action still probes login shells.
    sys.exit(0)

original = profile.read_bytes()
legacy = b'''if [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]; then
    [ -r /run/blacksmith/job.env ] && . /run/blacksmith/job.env
    [ -d "${GITHUB_WORKSPACE:-}" ] && cd "${GITHUB_WORKSPACE}"
fi'''
# Preserve per-job environment loading and interactive SSH navigation. Only the
# observed vendor stanza is ours to adapt; unfamiliar hooks must pass the probe.
interactive = legacy.replace(
    b'    [ -d "${GITHUB_WORKSPACE:-}" ] && cd "${GITHUB_WORKSPACE}"',
    b'    case $- in *i*) [ -d "${GITHUB_WORKSPACE:-}" ] && cd "${GITHUB_WORKSPACE}" ;; esac',
)
if original.count(legacy) > 1:
    sys.exit("Ambiguous Blacksmith SSH startup hook; refusing to rewrite it")
if legacy in original:
    profile.write_bytes(original.replace(legacy, interactive))

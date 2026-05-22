#!/bin/bash
# git-credential-hf-env — static git credential helper for huggingface.co.
#
# Emits the tenant's connected Hugging Face token (`HF_TOKEN`, staged as a
# Fly secret by platform-context/api/routers/connections.py when the user
# pastes a write-scoped PAT at /settings/connections) so plain
# `git clone` / `git push` against https://huggingface.co/... authenticate
# transparently — no per-turn `GIT_ASKPASS` improvisation by the agent.
#
# Wired up by entrypoint.sh (NOT the Dockerfile) only when HF_TOKEN is
# present, via:
#   git config --global credential.https://huggingface.co.helper \
#     '/usr/local/bin/git-credential-hf-env.sh'
#
# HuggingFace has no `gh auth setup-git` equivalent and the `hf` CLI ships
# no `git-credential` subcommand, so this tiny static helper is the HF-side
# analogue of what `gh auth setup-git` does for github.com.
#
# git invokes credential helpers with one of three actions on stdin
# (per `man gitcredentials`): `get`, `store`, `erase`. We only implement
# `get`; the token lifecycle is owned by the Fly secret, so there is
# nothing to store/erase locally.
#
# HF accepts any non-empty username when the password is a valid token;
# the conventional value (matching `huggingface_hub`'s own git usage) is
# the literal `hf_user` placeholder. The token in the password field is
# what authenticates.
#
# Output format (per `man gitcredentials`):
#   protocol=https
#   host=huggingface.co
#   username=hf_user
#   password=<HF_TOKEN>
#
# Fails silent (empty stdout, exit 0) if HF_TOKEN is absent — git then
# falls back to its usual credential resolution chain. That keeps the
# runtime usable for BYOK / open-weights tenants that never connected HF.

set -euo pipefail

action="${1:-}"
if [ "$action" != "get" ]; then
  exit 0
fi

# Drain git's stdin (key=value lines terminated by a blank line) so the
# credential protocol does not hang — we discard it; the answer comes
# from the env, not the requested URL.
while IFS= read -r _line; do
  if [ -z "$_line" ]; then
    break
  fi
done

# Bail silently if the tenant never connected Hugging Face.
if [ -z "${HF_TOKEN:-}" ]; then
  exit 0
fi

printf 'protocol=https\n'
printf 'host=huggingface.co\n'
printf 'username=hf_user\n'
printf 'password=%s\n' "$HF_TOKEN"

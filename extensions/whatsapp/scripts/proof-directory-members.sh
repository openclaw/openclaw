#!/usr/bin/env sh
set -eu

OPENCLAW_WHATSAPP_DIRECTORY_PROOF=1 corepack pnpm test extensions/whatsapp/src/directory-config.test.ts --maxWorkers=1

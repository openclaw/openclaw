## Summary

This PR adds documentation about the 2MB size limit for avatar images, addressing issue #65312.

## Changes

- **docs/cli/agents.md**: Added note about 2MB limit in the `set-identity` command documentation
- **docs/gateway/configuration-reference.md**: Added note about 2MB limit in the `identity.avatar` field documentation

## Problem

Users were spending time trying to figure out why their avatars don't work, putting them in the right folders, specifying correct paths, only to discover that avatars must be under 2MB. The error is silent and gives no hints as to why the avatar gets a 404.

## Solution

Added clear documentation about the 2MB size limit for avatar images in two key locations:
1. CLI reference for `openclaw agents set-identity`
2. Configuration reference for `agents.list[].identity.avatar`

## Impact

- Users will now be aware of the 2MB limit before attempting to use large avatar images
- Saves time and frustration for users who would otherwise encounter silent 404 errors
- Improves overall user experience

Fixes #65312

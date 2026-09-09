---
summary: "`plugins marketplace` entries, list, and refresh, plus hosted feed trust and signed feed profiles"
title: "Marketplace feeds"
read_when:
  - You want to browse, list, or refresh an OpenClaw marketplace feed
  - You are configuring a signed feed profile or pinning a feed payload checksum
---

This page covers `openclaw plugins marketplace`: reading entries, listing a
marketplace source, and refreshing a hosted feed snapshot.

## Marketplace

```bash
openclaw plugins marketplace entries
openclaw plugins marketplace entries --offline
openclaw plugins marketplace entries --json
openclaw plugins marketplace entries --feed-profile <name>
openclaw plugins marketplace entries --feed-url <url>
openclaw plugins marketplace list <source>
openclaw plugins marketplace list <source> --json
openclaw plugins marketplace refresh
openclaw plugins marketplace refresh --feed-profile <name>
openclaw plugins marketplace refresh --feed-url <url>
openclaw plugins marketplace refresh --expected-sha256 <sha256> --json
```

`plugins marketplace entries` lists entries from the configured OpenClaw marketplace feed. By default it attempts the hosted feed and falls back to the latest accepted snapshot or bundled data. Use `--feed-profile <name>` to read a specific configured profile, `--feed-url <url>` to read an explicit hosted feed URL, and `--offline` to read the latest accepted snapshot without fetching the feed.

`plugins marketplace refresh` refreshes the configured hosted feed snapshot and reports whether OpenClaw accepted hosted data, a hosted snapshot, or bundled fallback data. Use `--expected-sha256` when a caller needs the command to fail unless a fresh hosted payload matches a pinned checksum.

Marketplace `list` accepts a local marketplace path, a `marketplace.json` path, a GitHub shorthand like `owner/repo`, a GitHub repo URL, or a git URL. `--json` prints the resolved source label plus the parsed marketplace manifest and plugin entries.

Marketplace refresh loads a hosted OpenClaw marketplace feed and persists the
validated response as the local hosted-feed snapshot. Without options, it uses
the configured default feed profile. Use `--feed-profile <name>` to refresh a
specific configured profile, `--feed-url <url>` to refresh an explicit hosted
feed URL, `--expected-sha256 <sha256>` to require a matching payload checksum
(`sha256:<hex>` or a bare 64-character hex digest), and `--json` for
machine-readable output. Explicit hosted feed URLs must not include
credentials, query strings, or fragments. Unpinned refreshes can report a
hosted snapshot or bundled fallback result without failing the command. Pinned
refreshes fail unless they accept a fresh hosted payload, and successful hosted
refreshes fail if OpenClaw cannot persist the validated snapshot.

The built-in `clawhub-public` profile expects payload identity
`clawhub-official`. OpenClaw will bundle ClawHub's production public key after
ClawHub generates and hands off that key. Until then, the built-in profile does
not grant signed-feed install authority. Public keys must come from a trusted
release or operator channel, not from a key endpoint on the feed host.

OpenClaw verifies the DSSE envelope and, when a profile declares `feedId`,
requires the decoded payload ID to match it. The built-in `clawhub-public`
profile always declares its identity, preventing a valid document for another
feed from being replayed through that profile.

During the staged rollout, existing custom signed profiles that omit `feedId`
retain signature verification without payload-identity binding. New custom
profiles should declare `feedId`. The feed-profile configuration surface is
landing separately with the presentation metadata needed by Control UI; its
Doctor diagnostic must ask the operator to supply a missing identity and must
not infer one from the feed URL. This trust binding does not restore the retired
root `marketplaces` key.

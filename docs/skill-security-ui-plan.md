# Skill Security UI Plan

## Goal

A skill page should make trust state visible without forcing users to parse raw scan logs.

## Primary Display Elements

- current verdict
- policy action
- scan provider
- last scan timestamp
- last re-scan timestamp
- SHA-256 package hash
- publisher identity
- warning badge when verdict is `suspicious`, `malicious`, `unknown`, or `error`

## Version History View

Per version, show:

- version string
- package hash
- latest verdict
- latest policy action
- scan history timeline
- external report URL when present

## UX Rules

- `benign` => neutral / success badge
- `suspicious` => warning badge
- `malicious` => blocked badge
- `unknown` / `error` => manual review badge

## Suggested Panels

1. Overview
2. Latest scan
3. Findings summary
4. Version history
5. Audit trail

## Non-Goals

- no complicated SIEM dashboard
- no live exploit telemetry
- no “magic score” without explanation

---
summary: "First-use UX audit for making VeriClaw legible without a manual"
read_when:
  - Checking whether a brand-new user can operate the app immediately
  - Polishing the Apple-native correction workspace before release
  - Reviewing interaction changes that affect Control, Cases, or the hover widget
title: "First-Use UX Iteration"
---

# First-use UX iteration

Goal:

- a new user should understand where to start
- a new user should understand why a case exists
- a new user should understand whether the loop is actually closing
- the app should not require a README to perform the first useful action

## Problem statement

Earlier builds had strong visual polish, but first-use orientation was still too
dependent on user inference.

Main friction points:

- Control exposed multiple equal-weight actions without a clear `start here`
  path
- Cases detail contained rich data, but the correction loop state was still too
  implicit
- issue rows did not surface enough scan-friendly context for role drift or live
  treatment state
- the hover widget looked premium, but it did not expose enough case load or
  validation state to feel like a real supervision companion

## Changes landed on 2026-04-04

### Control

- added a state-based primary CTA in the hero:
  - degraded -> `Open Cases`
  - linking needed -> `Open Settings`
  - unknown -> `Refresh Status`
  - healthy/live -> `Open Chat` or `Continue Chat`
- restored the existing `Quick Actions` card into the main dashboard flow
- added a `Closed Loop` orientation card so the product teaches:
  - Control
  - Cases
  - Chat
  - Verify

### Cases

- added a `Closed Loop` section in the detail view
- each active case now shows a stage strip for:
  - Evidence
  - Diagnosis
  - Prescription
  - Verify
  - Casebook
- issue rows now expose a stronger scan line so a user can see role drift or
  live treatment state before opening detail
- row badges are now clearer about proof count, prior history, and role/casebook
  context

### Hover widget

- added active case count and pending synthetic validation count
- the `Cases` scene is now more explicit about whether:
  - there are active cases
  - there are pending trials
  - the workspace is quiet
- the `Cases` primary action now changes with loop state:
  - open cases -> `Review Focus Case` / `Review Open Cases`
  - queued validation only -> `Review Trial Queue`
  - quiet -> `Open Casebook`
- scene tabs now surface lightweight attention badges such as `Open`, `Queued`,
  or `Alert` so a user can see where supervision pressure lives before opening a
  panel
- compact mode now surfaces one state-driven primary action so the small widget
  still teaches the recommended first click
- expanded scene cards now show an inline interaction hint so swipe-vs-open
  behavior does not have to be inferred
- quiet-state chat copy now explicitly says `Start in chat` so a first-time user
  does not confuse an idle desk with a live-thread return state
- the currently recommended scene now surfaces a small `Start here` /
  `Recommended` badge in the scene card header
- the `Chat` secondary action is now state-driven:
  - open loops -> review cases
  - quiet healthy desk -> check pulse
  - linking needed -> open settings

## UX acceptance bar

The interface is acceptable only if all of these are true:

1. A new user can identify the first click from the Control hero alone.
2. A selected case explains:
   - what went wrong
   - what to do next
   - what stage of the correction loop is currently gating closure
3. The hover widget communicates whether supervision pressure is low or high
   without opening the full workspace.
4. The interface never asks the user to choose between equally-weighted entry
   points when the system already knows the better next step.

## Verification

Local verification after this pass:

- `pnpm mac:test`
- result: `436 tests` across `108 suites` passed on 2026-04-04

## Remaining UX risks

- App Store screenshots still need a fresh pass so the visual story matches the
  now-clearer first-use routing
- release media still needs a clean App + GitHub story pass so the widget and
  correction loop are represented without relying on unsupported surfaces
- real-world dogfooding should still validate whether the `Start here` CTA is
  sufficient or whether an even stronger one-task-only first state is needed

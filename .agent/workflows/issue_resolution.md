---
description: Strict protocol for resolving issues (Branch -> Fix -> Verify x3 -> PR)
---

# Issue Resolution Protocol

1.  **Preparation**
    - [ ] **Check for Existing PRs**: Search for open PRs related to the issue.
      - **Prioritize**: Issues WITHOUT open PRs.
      - **Exception**: High-value issues with weak/stalled existing PRs may be picked up if our solution is significantly more robust.
    - [ ] **Create Branch**: Always create a new branch from `main`.
      - `git checkout main`
      - `git pull`
      - `git checkout -b <type>/<description>` (e.g. `refactor/nostr-dispatcher`)

2.  **Implementation**
    - [ ] **Plan**: Create/Update `implementation_plan.md` (detailed).
    - [ ] **Brutal Plan Review**: rigorously review the plan. Do NOT write code until the plan is approved.
    - [ ] **Code**: Implement the fix or feature.

3.  **Verification (The "Brutal Review")**
    - [ ] **Local Testing**: Run relevant tests (`pnpm test`, etc.).
    - [ ] **Review Pass 1 (Logic)**: Check for logical errors, edge cases, and regression risks.
    - [ ] **Review Pass 2 (Style/Standards)**: Check for linting, typing, and code style.
    - [ ] **Review Pass 3 (Sanity)**: Final "vibe check" and holistic review.
    - [ ] **CI Check**: Check emails for any CI notifications (if applicable).

4.  **Finalization**
    - [ ] **Wait for Command**: Do NOT propose to commit. Wait for the user to explicitly ask you to commit.
    - [ ] **Commit**: Only after the user says "Commit", execute the commit.
    - [ ] **Done**: Stop here. Do NOT create a PR. Do NOT ask to create a PR. Wait for the user to handle the PR or give further instructions.

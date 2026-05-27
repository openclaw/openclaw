---
title: "Secure Multi-Agent Routing with DuckDuckGo and Perplexity MCP"
summary: "A documentation pattern for separating lightweight execution from research-heavy workflows using agent boundaries."
read_when:
  - You want to keep the default agent lightweight while reserving deep web research for a dedicated specialist agent.
---

This guide describes a community routing pattern for OpenClaw that separates routine execution from research-heavy workflows.

## Background

As users connect more tools and MCP servers, one default agent can become overloaded:

- expensive research APIs may be called too often;
- lightweight requests and deep research can mix in one execution context;
- tool boundaries become harder to reason about and audit.

The goal of this pattern is to keep everyday execution simple and predictable, while making deep research explicit and constrained.

## Pattern Overview

Use two agents with distinct responsibilities:

- `main` (default interaction and execution entrypoint)
- `web-researcher` (research-only specialist)

High-level flow:

1. `main` handles normal chat and execution.
2. `main` uses DuckDuckGo for lightweight search by default.
3. `main` delegates to `web-researcher` only when deep research is required.
4. `web-researcher` uses Perplexity MCP for multi-source research and synthesis.
5. `web-researcher` returns findings to `main`, and `main` remains the final execution surface.

## Responsibility Boundaries

### `main` agent

`main` should own routine work:

- normal Q&A;
- code edits;
- file operations;
- task planning;
- lightweight search (DuckDuckGo by default).

`main` should not call Perplexity MCP by default.

### `web-researcher` agent

`web-researcher` is a bounded specialist for complex web research:

- deep research;
- multi-source verification;
- architecture tradeoff analysis;
- model/API comparison;
- reasoning and summarization.

`web-researcher` should be restricted from execution-side actions:

- no file modification;
- no deployment;
- no deletion;
- no `git push`;
- no secret access or exposure.

## Layered Search Strategy

A practical decision policy:

- Use DuckDuckGo via `main` for quick fact checks, lightweight lookups, and low-cost retrieval.
- Escalate to `web-researcher` + Perplexity MCP only when tasks need:
  - deep synthesis across multiple sources;
  - stronger verification confidence;
  - architecture or vendor tradeoff judgment;
  - explicit user request for research-specialist handling.

This layered strategy keeps baseline cost and latency low while preserving a path for higher-confidence research.

## Security Boundaries

This pattern depends on strict hygiene:

- never commit real `.env` files;
- never commit API keys, tokens, or private keys;
- never upload user-specific runtime secrets;
- keep research agent permissions narrower than execution agents;
- enforce review/validation scripts before commits.

## Community Preset

A standalone community preset that demonstrates this pattern is available at:

- https://github.com/SeverinQuan/openclaw-sentinel

The preset includes example agent policies, routing rules, validation scripts, and security notes.

## Scope Note

This document describes an operational pattern and does **not** change OpenClaw core behavior.

# ChatGPT MCP Integration Plan

## Goal

Connect ChatGPT to `radar-claw-defender` through MCP-compatible tooling without changing the server into a generic API or execution platform.

The branch strategy for this work should follow the evergreen model:

- `main` mirrors upstream
- `radar/main` is the stable Radar integration base
- feature work for ChatGPT/MCP integration branches from `radar/main`

## Local first

Start with:

- local stdio MCP
- fixed defensive tool surface
- artifact-only inputs
- deterministic structured outputs

This is the easiest way to validate the tool contracts and keep the trust model simple.

## Remote later

A future remote MCP deployment should:

- expose the same tools, not a broader set
- keep request handling stateless where possible
- add auth and rate limiting at the edge
- avoid filesystem or shell capabilities

## What should stay disabled by default

- URL fetch tools
- browser tools
- shell tools
- repository mutation tools
- live scanning
- anything that increases offensive capability

## Auth considerations

- local stdio runs rely on the local operator boundary
- remote MCP should use dedicated auth, not reused operator credentials
- requests should be auditable without logging sensitive artifact contents

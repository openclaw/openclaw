# Monty Downstream Workflow

This doc applies only to downstream work in the public `ericberic/openclaw`
fork.

## Purpose

The fork may temporarily carry Monty-specific runtime fixes before they are
upstreamed or otherwise retired.

## Privacy Rules

Do not include private integration details in this public repo. Avoid posting:

- real user/account/channel identifiers
- real emails or phone numbers
- private server names
- private hostnames or filesystem paths
- copied private config from downstream deployments

Use sanitized reproduction and expected-behavior statements instead.

## Coordination Model

- Private integration, source-of-truth, and deployment context live outside
  this public repo.
- This fork owns the runtime implementation of downstream OpenClaw fixes.
- Do not assume a session in this repo automatically knows the private
  downstream context; provide a fresh sanitized handoff.

## Upstreaming Rule

- Keep downstream-only branches and docs separate from upstreamable branches.
- If preparing an upstream PR, exclude downstream-only policy/docs unless they
  are intentionally generic and acceptable for upstream review.

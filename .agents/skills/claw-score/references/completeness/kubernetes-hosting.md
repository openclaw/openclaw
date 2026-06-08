# Kubernetes Hosting Completeness

Use this rubric when assigning category Completeness scores for the
`kubernetes-hosting` surface.

## What Completeness Means Here

Completeness measures how fully OpenClaw supports Kubernetes as a cluster
hosting path for the Gateway. Score whether each category delivers the operator
workflow for deployment, configuration, secrets, access, exposure, lifecycle,
security posture, status, and recovery.

## Scoring Questions

For each category, ask:

- Can an operator deploy and manage OpenClaw on Kubernetes end to end?
- Are the taxonomy features present as supported manifests, commands, and docs rather than examples only?
- Are setup, normal operation, status or inspection, redeploy, teardown, and secret rotation represented where relevant?
- Are local Kind validation, namespace/image customization, provider secrets, and secure exposure branches covered?
- Do known gaps leave major cluster-hosting capability branches missing?

## Surface-Specific Guidance

- Favor higher Completeness when a Kubernetes operator can deploy, expose, secure, update, troubleshoot, and remove the Gateway without relying on Docker-only assumptions.
- Lower Completeness when a category only covers happy-path port-forwarding, lacks secret/config rotation, or omits exposed-service security posture.
- Do not lower Completeness because tests are thin; that is Coverage.
- Do not lower Completeness because implementation quality is fragile; that is Quality.

## Category Scope

- Deployment Setup: Kustomize packaging, cluster prerequisites, quick deploy, manifest apply, and Kind validation.
- Configuration and Secrets: agent instructions, Gateway config, provider secrets, secret rotation, and image/namespace customization.
- Access and Exposure: port-forward access, service endpoint, ingress exposure, auth/TLS, and localhost posture.
- Cluster Lifecycle: resource layout, state persistence, redeploy, teardown, and security context.

## Suggested Bands

- `Lovable` (95-100): complete across expected workflows, variants, and recovery branches, with only minor polish gaps.
- `Stable` (80-95): the expected workflow set is broadly present, with only bounded missing branches.
- `Beta` (70-80): the main workflow exists, but meaningful branches or recovery paths are still absent.
- `Alpha` (50-70): only a partial capability set is present; users can complete some core tasks but not the full expected workflow.
- `Experimental` (0-50): the category exposes only fragments of the intended capability.

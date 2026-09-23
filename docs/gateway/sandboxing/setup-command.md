---
summary: "The one-time container setup hook, where it is configured, and its common pitfalls"
title: "setupCommand (one-time container setup)"
read_when: "You need to run one-time setup inside a newly created sandbox container."
---

The hook that runs once after a sandbox container is created, and the defaults that most often make it fail.

## setupCommand (one-time container setup)

`setupCommand` runs **once** after the sandbox container is created (not on every run). It executes inside the container via `sh -lc`.

Paths:

- Global: `agents.defaults.sandbox.docker.setupCommand`
- Per-agent: `agents.entries.*.sandbox.docker.setupCommand`

<AccordionGroup>
  <Accordion title="Common pitfalls">
    - Default `docker.network` is `"none"` (no egress), so package installs will fail.
    - `docker.network: "container:<id>"` requires `dangerouslyAllowContainerNamespaceJoin: true` and is break-glass only.
    - `readOnlyRoot: true` prevents writes; set `readOnlyRoot: false` or bake a custom image.
    - `user` must be root for package installs. Docker can omit `user` or set
      `user: "0:0"`; rootful Podman must set `user: "0:0"` because its default
      preserves workspace ownership. Rootless Podman rejects zero-valued users;
      bake packages into the image or use rootful Podman.
    - Sandbox exec does **not** inherit host `process.env`. Use `agents.defaults.sandbox.docker.env` (or a custom image) for skill API keys.
    - Values in `agents.defaults.sandbox.docker.env` remain visible through container metadata commands such as `docker inspect` or `podman inspect`. Docker and Podman require portable environment names and single-line, non-NUL values because secure engine environment files are line-delimited; config validation and `openclaw doctor` reject invalid entries before sandbox use. Rename invalid keys, use single-line values, or deliver multiline material through a mounted file or custom image; this requires manual remediation because `doctor --fix` cannot safely preserve the original value. SSH and OpenShell backends still support multiline values. Use a custom image, mounted secret file, or another secret delivery path if metadata exposure is not acceptable.

  </Accordion>
</AccordionGroup>

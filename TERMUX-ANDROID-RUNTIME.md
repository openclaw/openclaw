# Android / Termux runtime notes

This note captures the boundary between what can be fixed in GitHub and what still has to happen on the live Android / Termux runtime.

## What GitHub-side automation can do

GitHub-connected tooling can:

- inspect repository files, branches, commits, pull requests, and issues
- create branches, files, commits, and pull requests
- review diffs and prepare repo-backed fixes
- document repeatable Termux / Android troubleshooting steps

GitHub-connected tooling cannot directly:

- type into a live Termux shell
- operate a live Codespaces terminal session
- approve Android permission prompts
- access uncommitted local-only files
- see runtime state unless it is pushed to the repo or pasted into a message

## What still has to happen on the device

The device operator or a paired runtime agent still has to:

- execute live shell commands in Termux / Codespaces
- approve permissions, notifications, overlays, storage, camera, microphone, and accessibility prompts
- enter secrets, tokens, passwords, and QR login steps
- restart long-running jobs and background services

## OpenClaw role

OpenClaw is the runtime agent / gateway, not just a crawler.
It can orchestrate broader device and channel workflows, while GitHub remains the source of truth for code and configuration.

A practical split is:

- OpenClaw: runtime orchestration, device-side actions, live agent work
- GitHub: code, configuration, review, history, PR-based changes
- device operator: permissions, approvals, live runtime execution, local-only files

## Termux HTTPS / certificate troubleshooting

If Python `requests` fails with `CERTIFICATE_VERIFY_FAILED` in Termux, verify the CA bundle and export it explicitly:

```bash
pkg install ca-certificates openssl
ls -l $PREFIX/etc/tls/cert.pem

export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
export REQUESTS_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"
export CURL_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"
```

To persist those variables:

```bash
cat >> ~/.bashrc <<'EOF'
export SSL_CERT_FILE="$PREFIX/etc/tls/cert.pem"
export REQUESTS_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"
export CURL_CA_BUNDLE="$PREFIX/etc/tls/cert.pem"
EOF

source ~/.bashrc
```

## Termux repo-state reminder

A local folder is not automatically a Git repository.
If `git status` says `fatal: not a git repository`, initialize it first:

```bash
git init
git branch -M main
```

Then add a remote only after choosing the correct repository:

```bash
git remote add origin https://github.com/<owner>/<repo>.git
```

## Recommended workflow

1. Do live execution in OpenClaw / Termux.
2. Push code or config you want reviewed into GitHub.
3. Use GitHub-connected tooling for repo inspection, edits, branches, and pull requests.
4. Keep device-specific secrets and approvals on the device side.

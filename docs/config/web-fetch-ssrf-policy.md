# Web Fetch SSRF policy: fake-ip proxy compatibility

OpenClaw `web_fetch` supports an SSRF policy override for fake-ip proxy environments.

## Configuration

```yaml
tools:
  web:
    fetch:
      ssrfPolicy:
        assumeProxyEnvironment: true
```

## When to use this

Enable this when `web_fetch` runs behind a fake-ip proxy environment (for example Clash or Surge fake-ip mode) and public hosts resolve to RFC2544 benchmark addresses such as:

- `198.18.x.x`
- `198.19.x.x`

Without this setting, `web_fetch` can block such requests as private/internal/special-use IPs even though the destination site is public.

## Behavior

### Disabled / unset

- RFC2544 fake-ip results are blocked by SSRF protection
- hostname blocklist remains enforced
- RFC2544 block errors include a fake-ip compatibility hint

### Enabled

- the `web_fetch` SSRF path assumes a fake-ip proxy environment
- IP range checks are skipped for that path
- hostname blocklist remains enforced

## Scope

This setting only affects the `web_fetch` SSRF path.
It is intentionally scoped under `tools.web.fetch.ssrfPolicy` instead of a global top-level network section.

## Difference from `dangerouslyAllowPrivateNetwork`

OpenClaw already supports:

```yaml
tools:
  web:
    fetch:
      ssrfPolicy:
        dangerouslyAllowPrivateNetwork: true
```

That setting is broader and more dangerous:

- it is an explicit private-network bypass

`assumeProxyEnvironment` is narrower:

- it is intended for fake-ip proxy compatibility for public web fetches

If the goal is to make `web_fetch` work behind fake-ip proxy environments, prefer:

- `tools.web.fetch.ssrfPolicy.assumeProxyEnvironment: true`

Use `dangerouslyAllowPrivateNetwork` only when you explicitly want the broader private-network bypass.

## CLI example

```bash
openclaw config set tools.web.fetch.ssrfPolicy.assumeProxyEnvironment true
```

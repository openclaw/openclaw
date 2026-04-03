# 2026-03-13 GitHub CLI EOF Under Proxy

## Summary

During Codex ACP debugging, GitHub issue creation worked but subsequent GitHub
comments repeatedly failed with:

- `Post "https://api.github.com/...": EOF`

At first glance this looked like a GitHub permissions or `gh` authentication
problem. It was neither. The root cause was the local proxy environment:

- `HTTP_PROXY=http://127.0.0.1:7890`
- `HTTPS_PROXY=http://127.0.0.1:7890`

Under that proxy chain, some GitHub requests worked, but GraphQL and REST
`POST` requests were unreliable and frequently terminated with `EOF`.

## Symptoms

Observed behavior on the same machine and same authenticated `gh` session:

- `gh auth status` succeeded
- `gh api repos/openclaw/openclaw/issues/44810` succeeded
- `gh api graphql ...` failed with `EOF`
- `gh api -X POST repos/openclaw/openclaw/issues/44810/comments ...` failed with
  `EOF`
- `gh api -X POST markdown ...` failed with `EOF`

This split was the key clue:

- some authenticated GitHub reads still worked
- GraphQL and `POST` traffic did not

## Verification

### Proxy-enabled environment

With the proxy variables present, GraphQL and REST `POST` calls failed:

```bash
gh api graphql -f query='query { viewer { login } }'
gh api -X POST markdown -f text='hello'
```

Representative failures:

- `Post "https://api.github.com/graphql": EOF`
- `Post "https://api.github.com/markdown": EOF`

`curl` also showed TLS instability through the proxy:

```bash
curl -I https://api.github.com
curl -I https://api.github.com/graphql
```

Representative failure:

- `LibreSSL SSL_connect: SSL_ERROR_SYSCALL`

### Proxy-disabled environment

Running the same GitHub `POST` without proxy variables succeeded:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  gh api -X POST markdown -f text='hello'
```

Returned successfully:

```html
<p>hello</p>
```

This proved the problem was not:

- GitHub token scopes
- `gh` login state
- issue permissions
- comment body formatting

It was the proxy path.

## Practical Impact

This affected follow-up GitHub operations during debugging:

- issue comments
- GraphQL-backed `gh` commands
- other REST `POST` calls

The misleading part is that issue creation or some `GET` requests may still
work, making the problem look intermittent or content-specific.

## Working Pattern

For GitHub write operations on this machine, use a no-proxy wrapper:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  gh api -X POST repos/openclaw/openclaw/issues/44810/comments --input /tmp/body.json
```

The same approach works for GraphQL diagnostics:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  gh api graphql -f query='query { viewer { login } }'
```

## Lessons

1. `gh auth status` passing does not prove GitHub write traffic is healthy.
2. If GitHub `POST` or GraphQL requests fail with `EOF`, test the same command
   with proxy variables removed before chasing auth or content issues.
3. A successful REST `GET` does not rule out proxy-related failures for `POST`.
4. Keep a minimal no-proxy `gh` wrapper ready for issue comments, PR comments,
   and GraphQL diagnostics.

## Recommended Quick Check

When GitHub CLI starts failing unexpectedly on this machine:

```bash
gh auth status -h github.com
gh api repos/openclaw/openclaw/issues/44810 --jq .number
gh api graphql -f query='query { viewer { login } }'
gh api -X POST markdown -f text='hello'
```

If GraphQL or `POST` fails with `EOF`, retry the same command with:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy
```

If the no-proxy version succeeds, the failure is in the proxy/network layer, not
GitHub auth.

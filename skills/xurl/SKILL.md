---
name: xurl
description: A CLI tool for making authenticated requests to the X (Twitter) API. Use this skill when you need to post tweets, reply, quote, search, read posts, manage followers, send DMs, upload media, or interact with any X API v2 endpoint.
metadata:
  {
    "openclaw":
      {
        "emoji": "🐦",
        "requires": { "bins": ["xurl"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "xdevplatform/tap/xurl",
              "bins": ["xurl"],
              "label": "Install xurl (brew)",
            },
            {
              "id": "npm",
              "kind": "npm",
              "package": "@xdevplatform/xurl",
              "bins": ["xurl"],
              "label": "Install xurl (npm)",
            },
          ],
      },
  }
---

# xurl — X API CLI

`xurl` is a CLI tool for the X API. Supports **shortcut commands** (one-liners) and **raw curl-style** access to any v2 endpoint. All output is JSON to stdout.

**Auth must be configured before use.** Run `xurl auth status` to check.

For full command details, examples, and workflows, read `references/command-reference.md`.

## Secret Safety (Mandatory)

- **Never** read, print, or send `~/.xurl` to LLM context
- **Never** use `--verbose` / `-v` in agent sessions (leaks auth headers)
- **Never** use inline secret flags: `--bearer-token`, `--consumer-key`, `--consumer-secret`, `--access-token`, `--token-secret`, `--client-id`, `--client-secret`
- Credential registration must be done manually by the user outside agent sessions
- After registration, authenticate with: `xurl auth oauth2`

## Quick Reference

| Action | Command |
|--------|---------|
| Post | `xurl post "Hello world!"` |
| Reply | `xurl reply POST_ID "Nice post!"` |
| Quote | `xurl quote POST_ID "My take"` |
| Delete | `xurl delete POST_ID` |
| Read | `xurl read POST_ID` |
| Search | `xurl search "QUERY" -n 10` |
| Who am I | `xurl whoami` |
| User lookup | `xurl user @handle` |
| Timeline | `xurl timeline -n 20` |
| Mentions | `xurl mentions -n 10` |
| Like/Unlike | `xurl like POST_ID` / `xurl unlike POST_ID` |
| Repost/Undo | `xurl repost POST_ID` / `xurl unrepost POST_ID` |
| Bookmark | `xurl bookmark POST_ID` / `xurl unbookmark POST_ID` |
| List bookmarks | `xurl bookmarks -n 10` |
| Follow/Unfollow | `xurl follow @handle` / `xurl unfollow @handle` |
| Block/Mute | `xurl block @handle` / `xurl mute @handle` |
| DM | `xurl dm @handle "message"` |
| List DMs | `xurl dms -n 10` |
| Upload media | `xurl media upload path/to/file.mp4` |
| Media status | `xurl media status MEDIA_ID` |
| Raw API | `xurl /2/users/me` or `xurl -X POST /2/tweets -d '{"text":"hi"}'` |

> **Post IDs vs URLs:** Anywhere `POST_ID` appears, you can paste a full URL — xurl extracts the ID.
> **Usernames:** `@` prefix is optional.

## Global Flags

| Flag | Description |
|------|-------------|
| `--app NAME` | Use a specific registered app |
| `--auth TYPE` | Force auth: `oauth1`, `oauth2`, or `app` |
| `-u USERNAME` | Which OAuth2 account to use |
| `-s` | Force streaming mode |

## Key Notes

- **Rate limits:** 429 = wait and retry. Write endpoints have stricter limits.
- **Token refresh:** OAuth 2.0 tokens auto-refresh. No manual intervention.
- **Multiple apps:** Switch with `xurl auth default APP` or `--app APP`
- Non-zero exit on error; API errors still JSON-parseable on stdout.

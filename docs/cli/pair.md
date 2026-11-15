---
summary: "CLI reference for `openclaw pair` (approve a browser showing a pairing code)"
read_when:
  - A browser shows a pairing code and you need to approve it
  - You want to connect a browser without pasting a Gateway token
title: "Pair"
---

# `openclaw pair`

Approve a browser that is showing a pairing code. Choose **Pair this browser** in the Control UI to get a code. See [Pair a browser with a code](/web/control-ui/connect-and-pair#pair-a-browser-with-a-code).

```bash
openclaw pair ABCD-EFGH
openclaw pair work:ABCD-EFGH
```

A Gateway running under a named profile shows its code with that profile in front, such as `work:ABCD-EFGH`. The command then uses the `work` profile, as if you had run `openclaw --profile work pair ABCD-EFGH`, and prints the profile it reached before asking. The prefix only chooses where the command connects; the eight characters after it are the code. A code naming a different profile than `--profile` is refused. With `--container`, the code goes unchanged to the CLI inside the container, which selects the profile there.

The command prints what the Gateway knows about the requesting browser, then asks before approving:

```text
A browser is asking to pair with administrator access to this Gateway.

  Gateway profile     work
  Code                ABCD-EFGH
  Browser (reported)  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ...
  Address             203.0.113.7
  Page (reported)     https://gateway.example
  Browser ID          1a2b3c4d
  Requested           just now
```

**Address** is the peer the Gateway saw. Rows marked `(reported)` come from the requester, so treat them as hints. Compare **Code** with the command on the page in front of you.

Approve only a code you requested yourself. Anyone can display a code, and approving one someone sent you gives their browser administrator control of your Gateway. Answering no tells the browser it was declined.

Approving pairs the browser the same way `openclaw devices approve` would: it becomes an operator device with the Control UI's administrator scopes, and your own connection must hold those scopes. It appears in `openclaw devices list` and the Devices page. To end its access, run `openclaw devices remove <deviceId>`.

If that browser is already paired and its operator token was revoked or rotated to fewer scopes, the command refuses instead of restoring it. To restore administrator access, run [`openclaw dashboard`](/cli/dashboard) on the Gateway host and open its link in that browser. Alternatively, remove the device with `openclaw devices remove <deviceId>` and run the same command again while the code is still valid.

Codes are not case-sensitive and the hyphen is optional. They expire after ten minutes and work once.

## Options

- `--yes`: approve without asking. The details are still printed.
- `--json`: print the result as JSON. Requires `--yes`.
- `--url <url>`, `--port <port>`, `--token <token>`, `--password <password>`, `--timeout <ms>`: choose the Gateway connection.

## Running it over SSH

A plain `ssh host openclaw pair ABCD-EFGH` has no terminal to answer the question, so nothing is approved. Use `ssh -t host openclaw pair ABCD-EFGH`.

## Requirements

The Gateway must be running, and the CLI connection needs `operator.admin`. Code pairing does not establish a signed-in user identity, so Gateways with `gateway.roles` configured refuse it; use the Gateway's identity-aware sign-in method instead.

If the command says no browser is waiting, check that it reaches the same Gateway the browser opened: copy the code with its profile prefix, and run it with the same `OPENCLAW_STATE_DIR` or `OPENCLAW_CONFIG_PATH` if that Gateway uses its own. A browser that confirmed **Cancel** has withdrawn its request, so its old code can no longer be approved. Cancellation does not revoke a device whose approval already completed; use Devices or `openclaw devices remove` for that.

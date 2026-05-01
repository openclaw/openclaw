---
summary: "Payment plugin: agent-driven purchases via virtual card (Stripe Link) and machine-payment (MPP/x402), with approval gating and sentinel-based card fill"
title: "Payment plugin"
sidebarTitle: "Payment"
read_when:
  - You want to let an agent make purchases on your behalf
  - You are configuring the payment plugin in openclaw.json
  - You need to understand the security model or sentinel-fill pattern
  - You want to understand approval requirements before money moves
---

The payment plugin gives the agent the ability to make purchases on your behalf. It supports two payment rails — `virtual_card` (browser-based checkout) and `machine_payment` (HTTP 402 / MPP protocol) — with two providers in V1: `stripe-link` for live payments and `mock` for testing. Every money-moving action requires your explicit approval. Raw card values never reach the agent transcript.

Related:

- CLI reference: [openclaw payment](/cli/payment)

## Quick start

<Steps>
  <Step title="Install the Stripe Link CLI">
    Follow the [Stripe Link CLI setup guide](https://stripe.com/docs/link/cli) to install `link-cli` on your machine.
  </Step>
  <Step title="Authenticate in test mode">
    ```bash
    link-cli auth login --test
    ```
    Test mode uses Stripe's sandbox — no real charges are made.
  </Step>
  <Step title="Configure the plugin">
    Add the `payment` entry under `plugins.entries` in your `openclaw.json`:

    ```json
    {
      "plugins": {
        "entries": {
          "payment": {
            "enabled": true,
            "config": {
              "enabled": true,
              "provider": "stripe-link",
              "providers": {
                "stripe-link": { "testMode": true }
              }
            }
          }
        }
      }
    }
    ```

  </Step>
  <Step title="Restart the Gateway">
    ```bash
    openclaw gateway restart
    ```
    After restart, run `openclaw payment setup` to confirm setup status.
  </Step>
</Steps>

## Configuration

All config lives under `plugins.entries.payment.config`.

| Field                                     | Type                        | Default                  | Description                                                               |
| ----------------------------------------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `enabled`                                 | boolean                     | `false`                  | Master switch. Must be `true` for the plugin to activate.                 |
| `provider`                                | `"stripe-link"` \| `"mock"` | —                        | Active provider. Required.                                                |
| `defaultCurrency`                         | string                      | `"usd"`                  | ISO 4217 currency code used when a currency is not specified.             |
| `store`                                   | string                      | `"~/.openclaw/payments"` | Directory for persistent handle state (JSONL).                            |
| `providers["stripe-link"].command`        | string                      | `"link-cli"`             | Path or name of the Stripe Link CLI binary.                               |
| `providers["stripe-link"].clientName`     | string                      | `"OpenClaw"`             | Client name shown in the Stripe Link UI.                                  |
| `providers["stripe-link"].testMode`       | boolean                     | `false`                  | When `true`, all spend requests use Stripe's sandbox.                     |
| `providers["stripe-link"].maxAmountCents` | integer                     | `50000`                  | Maximum amount in cents per virtual card request. Hard-capped at `50000`. |

**Why the `maxAmountCents` hard cap?** Stripe Link imposes a $500 limit per spend request. The schema enforces `maxAmountCents <= 50000` at parse time — values above 50000 are rejected with a validation error. You can set a lower limit in your config to further restrict what the agent can request.

### Full example

```json5
{
  plugins: {
    entries: {
      payment: {
        enabled: true,
        config: {
          enabled: true,
          provider: "stripe-link",
          defaultCurrency: "usd",
          store: "~/.openclaw/payments",
          providers: {
            "stripe-link": {
              command: "link-cli",
              clientName: "OpenClaw",
              testMode: false,
              maxAmountCents: 5000, // cap at $50 for this install
            },
            mock: {},
          },
        },
      },
    },
  },
}
```

## Provider matrix

| Provider      | virtual_card | machine_payment | Settlement assets  | Status            |
| ------------- | ------------ | --------------- | ------------------ | ----------------- |
| `stripe-link` | yes          | yes             | `usd_card`, `usdc` | V1                |
| `mock`        | yes          | yes             | `usd_card`, `usdc` | V1 (testing only) |

The `mock` provider completes all operations locally without network calls. Use it for integration testing and CI where Stripe credentials are unavailable.

## Tool actions

The agent accesses payment functionality through a single `payment` tool with five actions.

### `setup_status`

Check whether the configured provider is ready for use.

**Input:**

```json
{
  "action": "setup_status",
  "providerId": "stripe-link"
}
```

`providerId` is optional; omit to check the default provider.

**Approval:** none.

**Returns:** `{ available, reason?, authState?, providerVersion?, testMode? }`

---

### `list_funding_sources`

List payment methods available for the configured provider.

**Input:**

```json
{
  "action": "list_funding_sources",
  "providerId": "stripe-link"
}
```

**Approval:** none.

**Returns:** array of `FundingSource` objects with `id`, `displayName`, `rails`, `settlementAssets`, and optional `availableBalanceCents`.

---

### `issue_virtual_card`

Issue a single-use virtual card for browser-based checkout. This is the money-moving action for the `virtual_card` rail.

**Input:**

```json
{
  "action": "issue_virtual_card",
  "providerId": "stripe-link",
  "fundingSourceId": "<id from list_funding_sources>",
  "amount": {
    "amountCents": 2999,
    "currency": "usd"
  },
  "merchant": {
    "name": "Example Store",
    "url": "https://example.com"
  },
  "purchaseIntent": "Purchasing a blue widget (SKU W-123) from example.com for $29.99. The user asked to buy this item as part of their home office setup order.",
  "idempotencyKey": "optional-dedup-key"
}
```

`purchaseIntent` must be at least 100 characters. It is shown during the Stripe Link approval prompt on your phone.

**Approval:** `warning` severity. The approval description names the provider, amount, and merchant.

**Returns:** a `CredentialHandle` with:

- `id` — handle identifier
- `status` — `pending_approval | approved | denied | expired`
- `validUntil` — ISO 8601 expiry
- `display` — non-secret display fields (`brand`, `last4`, `expMonth`, `expYear`)
- `fillSentinels` — map of sentinel objects for browser form fill (see [Sentinel + hook pattern](#sentinel--hook-pattern))

**Note:** raw PAN, CVV, expiry digits, or holder name are never included in the result. The `fillSentinels` map contains safe reference objects, not card data.

---

### `execute_machine_payment`

Execute a machine-to-machine payment to an HTTP 402 endpoint using the Machine Payments Protocol (MPP). No browser is required.

**Input:**

```json
{
  "action": "execute_machine_payment",
  "providerId": "stripe-link",
  "fundingSourceId": "<id>",
  "targetUrl": "https://api.example.com/purchase",
  "method": "POST",
  "body": { "item": "widget-123" },
  "idempotencyKey": "optional-dedup-key"
}
```

`method` must be one of `GET`, `POST`, `PUT`, `PATCH`, `DELETE`.

**Approval:** `critical` severity. The approval description marks this as irreversible once settled.

**Returns:** a redacted `MachinePaymentResult` with `handleId`, `targetUrl`, `outcome` (`settled | failed | pending`), and an optional `receipt` (no SPT or raw payment token).

---

### `get_payment_status`

Look up the status of a previously issued handle.

**Input:**

```json
{
  "action": "get_payment_status",
  "handleId": "<id from issue_virtual_card>"
}
```

**Approval:** none.

**Returns:** the same redacted `CredentialHandle` shape as `issue_virtual_card`.

## Security model

The payment plugin applies multiple independent layers of protection so that card data does not appear in agent sessions, logs, or the assistant transcript.

### Approval gates

The SDK's `requireApproval.severity` union accepts `"info" | "warning" | "critical"`. The payment plugin maps actions as follows:

- `issue_virtual_card` — **`warning`** severity. Prompts in the OpenClaw approval surface before the spend request is created. Timeout behavior is `deny`.
- `execute_machine_payment` — **`critical`** severity. Prompts before the HTTP payment is executed. Timeout behavior is `deny`.
- Each browser-fill sentinel substitution — **`critical`** severity. One approval per fill call, even for the same handle.

Approval gates are additive to the buyer-side approval in the Stripe Link mobile app. When you approve an `issue_virtual_card` call in OpenClaw, the Stripe Link adapter then sends a `--request-approval` command to the Link CLI, which surfaces a biometric prompt (Face ID or passkey) on your registered phone. Both gates must pass before a card is issued.

See [Stripe Link CLI design](https://x.com/stevekaliski/status/2049959185077686704) for details on Stripe's cryptographic enforcement model: spend request tokens (SPTs) are bound to the seller's business profile at issue time, so a leaked token cannot be redirected to a different merchant.

### Card values never reach the agent

When the agent calls `issue_virtual_card`, the result it receives contains only `fillSentinels` — opaque reference objects of shape `{ $paymentHandle: string, field: "pan" | "cvv" | "exp_month" | "exp_year" | "holder_name" }`. These objects carry no real card data.

When the agent passes a sentinel as a field value in a `browser.act fill` call, the payment plugin's `before_tool_call` hook intercepts the call, retrieves the real card values from the provider, substitutes them into the rewritten params, and returns `{ requireApproval, params: rewrittenParams }` to the SDK runtime. The runtime holds the rewritten params in memory during the approval wait and applies them to the tool call only if you approve. On deny or timeout, the params are discarded.

The agent's `toolCall.arguments` in the transcript reflect the original sentinel values — the rewritten params with real card values are never written back to the assistant message. This is an architectural guarantee: `toolCall.arguments` are constructed from `tool_use.input` at SSE-parse time and are never overwritten by hook-rewritten params.

### Defense-in-depth redaction

A `before_message_write` hook scans every outgoing assistant message with `toolCall` blocks for PAN-shaped (16-digit), CVV-shaped (3-4 digit in card context), and Authorization-header patterns. If a match is found, the message write is blocked entirely. In a correctly functioning system this hook never fires; it is the last line of defense if the substitution path misbehaves.

## Sentinel + hook pattern

This section documents the full flow for `virtual_card` browser checkout end-to-end.

### Step 1 — Issue a virtual card

The agent calls `payment.issue_virtual_card`. After your approval in OpenClaw and your biometric approval on the Link mobile app, the result includes:

```json
{
  "handle": {
    "id": "hdl_...",
    "status": "approved",
    "validUntil": "2026-04-30T14:00:00Z",
    "display": { "brand": "Visa", "last4": "4242" }
  },
  "fillSentinels": {
    "pan": { "$paymentHandle": "hdl_...", "field": "pan" },
    "cvv": { "$paymentHandle": "hdl_...", "field": "cvv" },
    "exp_month": { "$paymentHandle": "hdl_...", "field": "exp_month" },
    "exp_year": { "$paymentHandle": "hdl_...", "field": "exp_year" },
    "holder_name": { "$paymentHandle": "hdl_...", "field": "holder_name" }
  }
}
```

### Step 2 — Open the checkout page

The agent uses the `browser` tool to navigate to the merchant's checkout page and snapshot the form fields.

### Step 3 — Fill the form with sentinels

The agent calls `browser` with `action: "act"` and a `fill` request, passing sentinel objects as field values:

```json
{
  "action": "act",
  "request": {
    "kind": "fill",
    "targetId": "t1",
    "fields": [
      { "ref": "e12", "type": "text", "value": { "$paymentHandle": "hdl_...", "field": "pan" } },
      { "ref": "e13", "type": "text", "value": { "$paymentHandle": "hdl_...", "field": "cvv" } },
      {
        "ref": "e14",
        "type": "text",
        "value": { "$paymentHandle": "hdl_...", "field": "exp_month" }
      },
      {
        "ref": "e15",
        "type": "text",
        "value": { "$paymentHandle": "hdl_...", "field": "exp_year" }
      }
    ]
  }
}
```

### Step 4 — Payment plugin intercepts and substitutes

The payment plugin's `before_tool_call` hook fires because:

1. `toolName === "browser"` and `request.kind === "fill"`.
2. One or more field values are sentinel-shaped.

The hook validates the handle, retrieves real card secrets from the provider, builds rewritten params with actual PAN/CVV/expiry values substituted, and returns `{ requireApproval: { severity: "critical", ... }, params: rewrittenParams }`.

### Step 5 — Approval

OpenClaw shows a `critical`-severity approval prompt. The description names the card's non-secret display info (`last4`, merchant name) and the field count. No real card values appear in the prompt.

On approval, the SDK runtime applies `rewrittenParams` to the tool call. The browser tool receives the rewritten fields and types the real values into the form. The agent sees only the display values and the sentinel echo in its transcript.

### Step 6 — Submit and verify

The agent submits the form via the browser tool and checks the resulting page for a confirmation or error.

## Retry guidance

Under the V1 consume-on-success model:

- A failed checkout (3DS abort, network error, browser timeout, form validation failure) does **not** consume the card. The same handle can be used to retry the fill until `validUntil` expires.
- Each retry fill substitution requires a fresh `critical`-severity approval.
- If `retrieveCardSecrets` returns a `card_unavailable` error, the card has been consumed or has expired. Issue a new virtual card (which triggers a new `warning`-severity approval and a new Link mobile app biometric prompt).

**EU/PSD2 note:** 3DS challenges are common for European-issued cards and many European merchants. When the checkout page presents a 3DS modal, the browser tool may return an error or show an unexpected dialog. This is expected behavior — retry the fill on the same handle after the 3DS flow completes or after dismissing the dialog. Plan for at least one retry pass on European checkout flows.

## Machine-payment flow (MPP)

The `execute_machine_payment` action targets HTTP 402 endpoints that implement the [Machine Payments Protocol (MPP)](https://mpp.dev/overview).

The adapter captures the spend request token (SPT) returned by the Link CLI, calls `mpp pay` against the target URL, and returns a redacted receipt. The SPT is held inside the adapter only for the duration of the call and never appears in the tool result, the agent transcript, or logs.

Stripe binds SPTs cryptographically to the seller's business profile at issuance time. A leaked or intercepted SPT cannot be redirected to a different merchant or URL.

**x402 is a planned future protocol** with the same HTTP 402 wire shape. See [x402 introduction](https://docs.x402.org/introduction) for the protocol specification. The V1 payment plugin supports MPP only; x402 support is deferred pending an x402 client library.

## Warning for plugin authors

If you are writing another OpenClaw plugin that registers an `after_tool_call` hook on the `browser` tool, be aware that you may receive substituted card values in `params.request.fields[].value` after a payment fill call.

**Why this happens:** The `before_tool_call` hook for browser fill returns `{ requireApproval, params: rewrittenParams }` where `rewrittenParams` contains real card values in the fields array. The runtime stores these rewritten params in an internal in-memory map (`adjustedParamsByToolCallId`) for the duration of the tool call. After the browser tool executes, the runtime retrieves and deletes the rewritten params, then dispatches them to all `after_tool_call` handlers as `event.params`. No redaction is applied at the dispatch site.

This means any `after_tool_call` handler registered by any plugin receives real PAN, CVV, and expiry values in `event.params.request.fields[].value` for browser fill calls that involved payment sentinels. No filtering based on which plugin issued the fill hook is applied.

**Safe uses in your hook:**

- Logging the count of rewritten fields (e.g., `"4 fields rewritten"`), without logging the values.
- Asserting that the form fill completed without errors.

**Unsafe uses in your hook — do not do these:**

- Persisting the params to disk, a database, or any durable store.
- Including the field values in error messages or structured error objects.
- Returning the raw field values in your hook result.
- Transmitting the params externally (telemetry, webhook, API call).

If your `after_tool_call` hook on `browser` receives substituted card values, treat them as transient secret material under the same discipline as the payment plugin's own internals: use them in memory only, for the duration of your hook, then let them go.

A future release will add `redactSensitiveValue()` at the `after_tool_call` dispatch site as a defense-in-depth measure. Until then, plugin authors are responsible for not persisting or forwarding `event.params` on browser tool calls.

## Limitations — what is not in V1

- **No `reveal_virtual_card` action.** This is intentional. The security model depends on card values never leaving the runtime as readable text. A reveal action would break this guarantee.
- **No Ramp adapter.** Ramp support is referenced in the feature plan; not implemented in V1.
- **No Mercury adapter.** Mercury support and the `bank_payment` rail are deferred.
- **No `reconciliation` rail.** Planned for a future unit when Ramp lands.
- **x402 protocol.** Planned for a future unit; V1 is MPP-only.
- **`maxAmountCents` is hard-capped at 50000.** Stripe Link does not support spend requests above $500.

Tracked deferred items are listed in `extensions/payment/DEV_NOTES.md` (developer-facing).

## References

- [Stripe Link CLI design — Steve Kaliski](https://x.com/stevekaliski/status/2049959185077686704)
- [Machine Payments Protocol (MPP)](https://mpp.dev/overview)
- [x402 protocol introduction](https://docs.x402.org/introduction)
- [openclaw payment CLI reference](/cli/payment)
- [Plugin hooks](/plugins/hooks)

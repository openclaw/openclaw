---
name: moonpay-virtual-account
description: Set up a virtual account for fiat on-ramp and off-ramp. Covers KYC, wallet registration, bank accounts, onramp (fiat to stablecoin), and offramp (stablecoin to fiat).
tags: [fiat]
metadata: { "openclaw": { "requires": { "bins": ["mp"] } } }
---

# Virtual account (fiat on-ramp & off-ramp)

## Goal

Set up and use a MoonPay virtual account to convert between fiat (USD/EUR) and stablecoins (USDC/USDT/EURC) on Solana, Ethereum, Polygon, Base, or Arbitrum.

## Setup flow

### 1. Create account and start KYC

```bash
mp virtual-account create
```

This creates the account and starts KYC verification automatically. It returns a URL to complete identity verification.

### 2. Check account status

```bash
mp virtual-account retrieve
```

The `status` field shows where you are. The `nextStep` field tells you what to do next.

### 3. KYC verification

```bash
# Check KYC status or get the verification link again
mp virtual-account kyc continue

# Restart KYC if something went wrong
mp virtual-account kyc restart
```

### 4. Accept required agreements

```bash
# List agreements that need to be accepted — shows name and URL for each
mp virtual-account agreement list
```

**Important:** Before accepting any agreement, show the user the agreement name and URL from the list output and ask them to open and review it. Only proceed once the user explicitly confirms they have read and agree to the terms.

```bash
# Accept an agreement (only after user confirms they have reviewed the URL)
mp virtual-account agreement accept --contentId <content-id>

# View previously accepted agreements
mp virtual-account agreement list --status accepted
```

### 5. Register a wallet

```bash
mp virtual-account wallet register --wallet main --chain solana
```

This creates the verification message, signs it locally, and registers — all in one command. Supported chains: solana, ethereum, polygon, base, arbitrum.

```bash
# List registered wallets
mp virtual-account wallet list
```

## Onramp (fiat to stablecoin)

```bash
# Create an onramp — returns deposit account (bank IBAN or account number)
mp virtual-account onramp create \
  --name "My Onramp" \
  --fiat USD \
  --stablecoin USDC \
  --wallet <registered-wallet-address> \
  --chain solana

# Get onramp details (includes deposit account, fees, legal disclaimer)
mp virtual-account onramp retrieve --onrampId <id>

# List onramps
mp virtual-account onramp list

# Update an onramp (change wallet, chain, or stablecoin)
mp virtual-account onramp update --onrampId <id> --chain ethereum

# Cancel an onramp
mp virtual-account onramp cancel --onrampId <id>

# Create an open banking payment
mp virtual-account onramp payment create \
  --onrampId <id> \
  --amount 100 \
  --fiat USD

# Check payment status
mp virtual-account onramp payment retrieve \
  --onrampId <id> \
  --paymentId <payment-id>
```

## Offramp (stablecoin to fiat)

### Register a bank account first

```bash
# Register a USD bank account (ACH)
mp virtual-account bank-account register \
  --currency USD \
  --type ACH \
  --accountNumber <number> \
  --routingNumber <number> \
  --providerName "Chase" \
  --providerCountry US \
  --givenName John \
  --familyName Doe \
  --email john@example.com \
  --phoneNumber +14155551234 \
  --address.street "123 Main St" \
  --address.city "New York" \
  --address.state NY \
  --address.country US \
  --address.postalCode 10001

# List registered bank accounts
mp virtual-account bank-account list

# Delete a bank account
mp virtual-account bank-account delete --bankAccountId <id>
```

### Create and use an offramp

```bash
# Create an offramp
mp virtual-account offramp create \
  --name "My Offramp" \
  --fiat USD \
  --stablecoin USDC \
  --chain solana

# List offramps
mp virtual-account offramp list

# Get offramp details
mp virtual-account offramp retrieve --offrampId <id>

# Update an offramp (change fiat currency / bank account)
mp virtual-account offramp update --offrampId <id> --fiat EUR

# Cancel an offramp
mp virtual-account offramp cancel --offrampId <id>

# Send stablecoin to an approved offramp (signs and broadcasts locally)
mp virtual-account offramp initiate \
  --wallet main \
  --offrampId <id> \
  --amount 100
```

## Other commands

```bash
# List transactions
mp virtual-account transaction list
```

## Related skills

- **moonpay-auth** — Login and wallet setup (required before virtual account)
- **moonpay-check-wallet** — Check stablecoin balances
- **moonpay-swap-tokens** — Swap or bridge stablecoins after onramp

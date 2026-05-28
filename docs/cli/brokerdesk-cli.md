---
summary: "CLI reference for `pnpm brokerdesk:cli` (BrokerDesk command wrapper)"
read_when:
  - You want one entrypoint for common BrokerDesk quote and paper-HFT scripts
  - You are reducing manual command switching across brokerdesk scripts
title: "BrokerDesk CLI Wrapper"
---

# `pnpm brokerdesk:cli`

`brokerdesk:cli` is a thin wrapper over existing `brokerdesk:*` scripts.
It does not place orders and does not bypass existing safety gates.

## Usage

```bash
pnpm brokerdesk:cli <command> [-- <args...>]
```

## Commands

- `status` -> `brokerdesk:quote:status`
- `quote-read` -> `brokerdesk:quote:read`
- `quote-pump` -> `brokerdesk:quote:pump`
- `quote-ui` -> `brokerdesk:quote:ui`
- `stock-list` -> `brokerdesk:hft:stock-list`
- `paper-loop` -> `brokerdesk:paper-loop`
- `paper-loop-check` -> `brokerdesk:paper-loop:check`
- `paper-trigger` -> `brokerdesk:paper-hft:trigger`
- `paper-trigger-check` -> `brokerdesk:paper-hft:trigger:check`
- `capital-overseas-rotation` -> `brokerdesk:capital:overseas-rotation`
- `capital-overseas-rotation-check` -> `brokerdesk:capital:overseas-rotation:check`
- `capital-master-checklist` -> `brokerdesk:capital:master-flow-checklist`

## Examples

```bash
pnpm brokerdesk:cli status -- --json
pnpm brokerdesk:cli stock-list -- --json --market 2
pnpm brokerdesk:cli paper-loop
pnpm brokerdesk:cli paper-loop-check
pnpm brokerdesk:cli capital-overseas-rotation
```

## Dry run

```bash
pnpm brokerdesk:cli status --dry-run
```

## Self check

```bash
pnpm brokerdesk:cli:check
```

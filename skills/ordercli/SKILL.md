---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: ordercli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Foodora-only CLI for checking past orders and active order status (Deliveroo WIP).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://ordercli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🛵",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["ordercli"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/ordercli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["ordercli"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install ordercli (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/ordercli/cmd/ordercli@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["ordercli"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install ordercli (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# ordercli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `ordercli` to check past orders and track active order status (Foodora only right now).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start (Foodora)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora countries`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora config set --country AT`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora login --email you@example.com --password-stdin`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora orders`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora history --limit 20`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora history show <orderCode>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Orders（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Active list (arrival/status): `ordercli foodora orders`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Watch: `ordercli foodora orders --watch`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Active order detail: `ordercli foodora order <orderCode>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- History detail JSON: `ordercli foodora history show <orderCode> --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Reorder (adds to cart)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Preview: `ordercli foodora reorder <orderCode>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm: `ordercli foodora reorder <orderCode> --confirm`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Address: `ordercli foodora reorder <orderCode> --confirm --address-id <id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Cloudflare / bot protection（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Browser login: `ordercli foodora login --email you@example.com --password-stdin --browser`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Reuse profile: `--browser-profile "$HOME/Library/Application Support/ordercli/browser-profile"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Import Chrome cookies: `ordercli foodora cookies chrome --profile "Default"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Session import (no password)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora session chrome --url https://www.foodora.at/ --profile "Default"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli foodora session refresh --client-id android`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Deliveroo (WIP, not working yet)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires `DELIVEROO_BEARER_TOKEN` (optional `DELIVEROO_COOKIE`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli deliveroo config set --market uk`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ordercli deliveroo history`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--config /tmp/ordercli.json` for testing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Confirm before any reorder or cart-changing action.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

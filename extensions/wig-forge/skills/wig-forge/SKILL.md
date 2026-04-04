---
name: wig-forge
description: Turn captured web imagery into wearable asset loot, then inspect and equip the results.
metadata:
  {
    "openclaw":
      {
        "homepage": "https://github.com/openclaw/openclaw",
        "toolNames": ["wig_forge_mint", "wig_inventory_list", "wig_inventory_equip"],
      },
  }
---

Use this skill when an OpenClaw bot should treat a captured visual from the web as forgeable loot.

Core flow:

1. Call `wig_forge_mint` with a capture image as `sourceDataUrl` or `sourceBase64`.
2. Include `originUrl`, `nameHint`, `styleTags`, and quality hints when known.
3. Read the returned rarity, slot, and stored asset details.
4. Call `wig_inventory_equip` if the asset should be worn immediately.
5. Call `wig_inventory_list` to inspect the current collection and loadout.

Rules:

- Prefer minting only after a real capture exists.
- Prefer preserving the real source URL in `originUrl`.
- When the source is repetitive, expect rarity to decay because the forge tracks duplicate fingerprints.
- Treat `wig_forge_mint` as the authoritative source of rarity and variant metadata.

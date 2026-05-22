---
name: pokemon-colombia
description: Buscar productos Pokemon TCG en Avalon Gaming, LX Store Colombia y Walker Golden Cards, incluyendo busqueda, ultimos productos y preventas.
metadata: { "openclaw": { "emoji": "🎴", "requires": { "bins": ["bun"] } } }
---

# pokemon-colombia

Use this skill when the user asks for Pokemon TCG product availability, prices, preorders, latest products, or product search across Colombian stores:

- Avalon Gaming
- LX Store Colombia
- Walker Golden Cards

Run the scraper instead of relying on generic web search:

```bash
bun {baseDir}/pokemon-colombia.ts --query "elite" --limit 5
```

Options:

- `--query <term>`: search term for the `busqueda` section. Default: `elite`.
- `--limit <n>`: products per store and section. Default: `5`.
- `--json`: emit raw JSON instead of a Markdown report.

Output sections:

- `busqueda`: 5 search results per store.
- `ultimos`: 5 latest products per store.
- `preventas`: 5 preorder/category results per store.

When the user asks for the cheapest preorder, compare `finalPrice` first when present. Some stores expose the preorder deposit/reservation as `price` and the total product price inside the title; the script normalizes that as `finalPrice`. Avalon `chaos-rising` products are valid preorders even though they currently show `Disponible Próximamente` without a public price, so report them separately as "sin precio publicado" instead of saying Avalon has no preorders.

Store mapping:

- Avalon search: `https://avalongaming.com.co/?s=<query>&post_type=product...`
- Avalon latest: WooCommerce Store API ordered by date.
- Avalon preventas: WordPress product category `chaos-rising`, which is shown on `https://avalongaming.com.co/pokemon-tcg/` as `Disponible Próximamente`.
- LX search: `https://lxstore.com.co/?s=<query>`.
- LX latest: WooCommerce Store API ordered by date.
- LX preventas: category `preventas` from `https://lxstore.com.co/product-category/cartas-y-albumes/preventas/`.
- Walker search: `https://www.walkergoldencards.com/search?q=<query>`.
- Walker latest: product sitemap sorted by `lastmod`, then product pages.
- Walker preventas: `https://www.walkergoldencards.com/preventa`.

If a store returns fewer than 5 items, report the count explicitly and include any warning from the script.

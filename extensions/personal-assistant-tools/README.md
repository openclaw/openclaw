# Personal Assistant Tools Extension

This extension provides optional placeholder tools for a multi-role personal assistant setup:

- `market_data_tool`
- `idea_generation_tool`
- `brainstormer_tool`
- `code_generation_tool`
- `trend_finder_tool`

These tools are intentionally scaffold-level and return structured stubs so you can plug in real APIs later.

## Intended roles

- `market_analyst`
- `brainstormer`
- `product_architect`
- `software_engineer`
- `trend_finder`

## Notes

- `market_data_tool` is analysis-only and must never execute trades.
- `trend_finder_tool` is designed for daily under-the-radar trend reporting workflows.
- Keep tools optional and role-scoped via agent-level allowlists.

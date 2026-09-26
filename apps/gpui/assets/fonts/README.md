# Instrument Sans

These static Latin faces are derived from the repository's
`ui/public/fonts/instrument-sans-latin.woff2` and
`instrument-sans-italic-latin.woff2`. Their original SIL Open Font License is
preserved in `instrument-sans-OFL.txt`; no Reserved Font Name is declared.

GPUI's macOS font matcher selects among loaded faces by weight and style. It
does not instantiate variable-font axes, so loading the web's two variable
faces makes all requested weights select their regular/default instance.
These TTFs bake the `wght` axis at 400, 500, 600, and 700 with `wdth=100`,
including italic counterparts. Family, subfamily, PostScript, OS/2 weight,
and style records identify the distinct faces to Core Text.

Regenerate from the repository root with the transient development tools:

```sh
uv run --with fonttools --with brotli python apps/gpui/assets/fonts/generate.py
```

No Python package or font conversion tool is needed to build or run the app.

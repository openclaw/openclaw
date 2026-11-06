# 1Password marks

`icon.png` is the plugin's existing, unmodified 1Password Lock mark.
`logo-iron-ore.png` and `logo-white.png` are unmodified primary logos from
1Password's official [media kit](https://1password.com/press), linked to the
[Brand Hub media kit](https://brand.1password.com/document/45), downloaded
November 2, 2026 (`2026_1Password Media kit/01_Logos/`).

The [logo guidelines](https://brand.1password.com/document/9#/foundations/logo)
require the complete primary logo somewhere in a design using the standalone
Lock. The approval card includes it in its footer or completed row. Do not
stretch, recolor, crop, or substitute typography for these marks.

The current [color guidelines](https://brand.1password.com/document/9#/foundations/color)
specify **Secure Blue (600), #145FE4 / RGBA 20, 95, 228, 1**, not the older
commonly cited #0572EC. The button uses this current hero hue.

Regenerate the embedded browser assets after changing an original:

```sh
node extensions/onepassword/scripts/generate-browser-brand.mjs
```

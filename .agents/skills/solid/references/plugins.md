# Plugin views in Solid

Plugin Control UI views compile through the shared plugin builder (`scripts/build-plugin-control-ui.mts`), which supports Solid TSX. `docs/plugins/feature-plugins.md` owns the authoring contract; `extensions/x` and `extensions/workboard` are the worked examples.

- Declare `solid-js` and `@solidjs/web` as the plugin's runtime dependencies at the repository's pinned versions, and `@solidjs/compiler`/`esbuild` as development dependencies, as the docs describe.
- The builder's emitted-import guard checks the **output**: the bundle may keep only literal dynamic imports that point at bundled files. Don't fight it with runtime-built import paths.
- Talk to the host only through the plugin SDK and its documented Control UI contract. Never import Control UI internals, the host's primitives, or another plugin's files.
- Don't rely on elements the host happens to register (for example `wa-*` tags). Those were an implicit contract that ends with the Web Awesome exit. Use native elements (`<dialog>`, `popover`, native inputs) inside the plugin, with the same focus entry/return and cancellation behavior.
- Keep the plugin's host tags, classes, and E2E selectors stable. Prove the actual built bundle in a native-host E2E, not only the source.

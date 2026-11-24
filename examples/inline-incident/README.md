# Native inline incident views

A complete, synthetic example of a plugin tool returning a data descriptor for
an installed browser component. No tool or model is rerun when history mounts.

From the repository root of an OpenClaw source checkout containing native inline view support:

```sh
pnpm install --frozen-lockfile
pnpm --dir examples/inline-incident build
pnpm --dir examples/inline-incident validate
pnpm openclaw plugins install ./examples/inline-incident
```

Enable **Settings → Labs → Custom plugin UI**, then ask an agent to show incident
INC-42. The native card appears immediately. Acknowledge changes the synthetic
record through an `operator.write` Gateway method, not a model turn. Open incident
panel uses the card session and agent and the shared plugin module state.
Reload or scroll away/back to exercise repeatable read-only mounting. The saved
version-1 payload contains only an incident id: each mount may fetch fresh state.
It is deliberately not a snapshot. Deleted or changed resources are the plugin's
responsibility; a self-contained historical snapshot would also be valid.

Backend declaration, tool emission, and renderer all use interface version 1
(independent of package version). To change that payload contract, register an
explicit new version and retain the old registration if old records should render.
Missing or unsupported renderers leave the saved summary and payload intact.
The example's development dependency links to this workspace's OpenClaw; when
copying it into a standalone project, replace that workspace link with your
installed OpenClaw version.

The two demo records are shared by all authorized operators; state intentionally
resets when the backend plugin reloads. Production backends must check resource
ACLs for the current viewer and use plugin-owned durable storage. Never use a
persisted id or the original tool caller privileges as authority.

Rendering uses `textContent`, not HTML interpolation. See the
[feature plugin guide](https://docs.openclaw.ai/plugins/feature-plugins#inline-views-from-tools)
for payload bounds, historical compatibility, lifecycle, and trust responsibilities.

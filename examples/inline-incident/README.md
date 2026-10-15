# Native inline incident views

A complete, synthetic example of a plugin tool returning a data descriptor for
an installed browser component. No tool or model is rerun when history mounts.

With an OpenClaw source/install containing native inline view support:

```sh
cd examples/inline-incident
npm install
npm run build
npm run validate
openclaw plugins install .
```

Enable **Settings → Labs → Custom plugin UI**, then ask an agent to show incident
INC-42. The native card appears immediately. Acknowledge changes the synthetic
record through an `operator.write` Gateway method, not a model turn. Open incident
panel uses the card session and agent and the shared plugin module state.
Reload or scroll away/back to exercise repeatable read-only mounting.

The two demo records are shared by all authorized operators; state intentionally
resets when the backend plugin reloads. Production backends must check resource
ACLs for the current viewer and use plugin-owned durable storage. Never use a
persisted id or the original tool caller privileges as authority.

Rendering uses `textContent`, not HTML interpolation. See the
[feature plugin guide](https://docs.openclaw.ai/plugins/feature-plugins#inline-views-from-tools)
for payload bounds, historical compatibility, lifecycle, and trust responsibilities.

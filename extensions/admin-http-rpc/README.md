# Admin HTTP RPC

Call selected Gateway administration methods over HTTP from trusted automation.
The plugin adds `POST /api/v1/admin/rpc` to the Gateway listener and dispatches
only its documented method allowlist.

## Get started

Enable the bundled plugin:

```bash
openclaw plugins enable admin-http-rpc
```

Use the Gateway's HTTP authentication and send a JSON request with `method` and
`params`. Start with the read-only `health` method.

This is a full operator surface. Keep it on loopback, a tailnet, or a trusted
private ingress; do not expose it directly to the public internet. The route
is absent while the plugin is disabled.

See the [Admin HTTP RPC guide](https://docs.openclaw.ai/plugins/admin-http-rpc)
for authentication, allowed methods, and request examples.

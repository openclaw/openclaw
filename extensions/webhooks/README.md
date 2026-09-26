# Webhooks

Connect trusted external automation to OpenClaw TaskFlow tracking over HTTP.
Routes can create, inspect, and update flow and child-task records. Your
external controller runs the workflow; these record operations do not start
agent turns.

## Get started

Enable the plugin and add a route with a session key and a unique secret under
`plugins.entries.webhooks.config.routes`. Configure your automation to send the
documented JSON actions with the route's authentication secret. Use HTTPS when
connecting from outside the host.

The plugin has no active routes until configured.

See the [Webhooks guide](https://docs.openclaw.ai/plugins/webhooks) for route
configuration, authentication, and supported actions.

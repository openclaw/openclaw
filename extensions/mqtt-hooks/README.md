# MQTT Hooks

`mqtt-hooks` is an official OpenClaw extension that consumes MQTT messages and maps them onto the existing ingress action model:

- `wake`
- `agent`

It does not add a second webhook-style runtime. It reuses the same agent/session policies and the same isolated agent-turn semantics as HTTP hooks.

## Guarantees

- Processing model: at-least-once best effort
- No transform scripts
- No custom expression language
- Retained messages are ignored on startup by default

## Example

```json5
{
  plugins: {
    entries: {
      "mqtt-hooks": {
        enabled: true,
        config: {
          broker: {
            url: "mqtt://broker.local:1883",
            clientId: "openclaw-mqtt-hooks",
            username: "openclaw",
            password: "${MQTT_PASSWORD}",
          },
          runtime: {
            maxPayloadBytes: 262144,
            maxConcurrentMessages: 4,
            dedupeWindowMs: 30000,
          },
          subscriptions: [
            {
              id: "home-alerts",
              topic: "home/alerts/#",
              qos: 1,
              action: "agent",
              agentId: "hooks",
              wakeMode: "now",
              deliver: true,
              channel: "last",
              ignoreRetainedOnStartup: true,
              messageTemplate: "Source: MQTT\nTopic: {{topic}}\nDescription: {{semantic.description}}\nPayload:\n{{payloadText}}",
              semantic: {
                description: "Home alert event",
                payloadHint: "JSON field `level` is the severity; `message` is the alert text.",
                intentHint: "Decide whether the user should be notified immediately.",
              },
            },
          ],
        },
      },
    },
  },
}
```

## Notes

- `hooks.allowedAgentIds`, `hooks.defaultSessionKey`, and related session policies still apply.
- If plugin config changes, restart the gateway so the service reconnects with the new broker/subscription set.

---
summary: "Hiding system messages, cancelling runs, cross-context messaging, and the steering queue"
title: "Chat commands, aborting tasks, and stopping a run"
read_when:
  - A task will not stop, or the bot ignores rapid messages
  - You are tuning slash commands or the queue
---

## Chat commands, aborting tasks, and "it will not stop"

<AccordionGroup>
  <Accordion title="How do I stop internal system messages from showing in chat?">
    Most internal/tool messages only appear when **verbose**, **trace**, or **reasoning** is enabled for that session.

    Fix in the chat where you see it:

    ```text
    /verbose off
    /trace off
    /reasoning off
    ```

    Still noisy: check session settings in the Control UI and set verbose to **inherit**; confirm you are not using a bot profile with `verboseDefault: "on"` in config.

    Docs: [Thinking and verbose](/tools/thinking), [Security](/gateway/security/index#reasoning-and-verbose-output-in-groups).

  </Accordion>

  <Accordion title="How do I stop/cancel a running task?">
    Send any of these **as a standalone message** (no slash) to trigger an abort: `stop`, `stop action`, `stop current action`, `stop run`, `stop current run`, `stop agent`, `stop the agent`, `stop openclaw`, `openclaw stop`, `stop don't do anything`, `stop do not do anything`, `stop doing anything`, `do not do that`, `please stop`, `stop please`, `abort`, `esc`, `exit`, `interrupt`, `halt`. Common non-English triggers (French, German, Spanish, Chinese, Japanese, Hindi, Arabic, Russian) also work.

    For background processes started by the exec tool, ask the agent to run:

    ```text
    process action:kill sessionId:XXX
    ```

    Most slash commands must be sent as a **standalone** message starting with `/`, but a few shortcuts (like `/status`) also work inline for allowlisted senders. See [Slash commands](/tools/slash-commands).

  </Accordion>

  <Accordion title='How do I send a Discord message from Telegram? ("Cross-context messaging denied")'>
    OpenClaw blocks **cross-provider** messaging by default. If a tool call is bound to Telegram, it will not send to Discord unless you explicitly allow it - and this takes effect immediately, no gateway restart needed:

    ```json5
    {
      tools: {
        message: {
          crossContext: {
            allowAcrossProviders: true,
            marker: { enabled: true, prefix: "[from {channel}] " },
          },
        },
      },
    }
    ```

  </Accordion>

  <Accordion title='Why does it feel like the bot "ignores" rapid-fire messages?'>
    Mid-run prompts are steered into the active run by default. Use `/queue` to choose active-run behavior:

    - `steer` (default) - guide the active run at the next model boundary.
    - `followup` - queue messages and run them one at a time after the current run ends.
    - `collect` - queue compatible messages and reply once after the current run ends.
    - `interrupt` - abort the current run and start fresh.

    Add options to queued modes like `debounce:0.5s cap:25 drop:summarize`. See [Command queue](/concepts/queue) and [Steering queue](/concepts/queue-steering).

  </Accordion>
</AccordionGroup>

---
summary: "Kung ano ang nilalaman ng OpenClaw system prompt at kung paano ito binubuo"
read_when:
  - Pag-eedit ng text ng system prompt, listahan ng tools, o mga seksyon ng oras/heartbeat
  - Pagbabago ng workspace bootstrap o behavior ng skills injection
title: "System Prompt"
---

# System Prompt

Bumubuo ang OpenClaw ng isang custom system prompt para sa bawat agent run. Ang prompt ay **pagmamay-ari ng OpenClaw** at hindi gumagamit ng default prompt ng p-coding-agent.

Ang prompt ay binubuo ng OpenClaw at ini-inject sa bawat agent run.

## Structure

Ang prompt ay sinadyang compact at gumagamit ng mga fixed na seksyon:

- **Tooling**: kasalukuyang listahan ng tools + maiikling paglalarawan.
- **Safety**: maikling paalala ng guardrail para iwasan ang power-seeking behavior o pag-bypass ng oversight.
- **Skills** (kapag available): nagsasabi sa model kung paano i-load ang mga instruksyon ng skill on demand.
- **OpenClaw Self-Update**: kung paano patakbuhin ang `config.apply` at `update.run`.
- **Workspace**: working directory (`agents.defaults.workspace`).
- **Documentation**: lokal na path papunta sa OpenClaw docs (repo o npm package) at kung kailan ito babasahin.
- **Workspace Files (injected)**: nagpapahiwatig na ang mga bootstrap file ay kasama sa ibaba.
- **Sandbox** (kapag naka-enable): nagpapahiwatig ng sandboxed runtime, mga sandbox path, at kung available ang elevated exec.
- **Current Date & Time**: oras na lokal sa user, timezone, at time format.
- **Reply Tags**: opsyonal na reply tag syntax para sa mga suportadong provider.
- **Heartbeats**: heartbeat prompt at ack behavior.
- **Runtime**: host, OS, node, model, repo root (kapag na-detect), thinking level (isang linya).
- **Reasoning**: kasalukuyang antas ng visibility + hint para sa /reasoning toggle.

Safety guardrails in the system prompt are advisory. They guide model behavior but do not enforce policy. Use tool policy, exec approvals, sandboxing, and channel allowlists for hard enforcement; operators can disable these by design.

## Prompt modes

OpenClaw can render smaller system prompts for sub-agents. The runtime sets a
`promptMode` for each run (not a user-facing config):

- `full` (default): kasama ang lahat ng seksyon sa itaas.
- `minimal`: used for sub-agents; omits **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies**, and **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (when known), Runtime, and injected
  context stay available.
- `none`: ibinabalik lamang ang base identity line.

Kapag `promptMode=minimal`, ang mga extra na injected prompt ay nilalabel bilang **Subagent
Context** sa halip na **Group Chat Context**.

## Workspace bootstrap injection

Ang mga bootstrap file ay tine-trim at idinadagdag sa ilalim ng **Project Context** para makita ng model ang identity at profile context nang hindi na nangangailangan ng tahasang pagbasa:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (para lamang sa mga bagong-bagong workspace)

Large files are truncated with a marker. The max per-file size is controlled by
`agents.defaults.bootstrapMaxChars` (default: 20000). Missing files inject a
short missing-file marker.

Maaaring saluhin ng mga internal hook ang hakbang na ito sa pamamagitan ng `agent:bootstrap` para baguhin o palitan
ang mga injected na bootstrap file (halimbawa, pagpapalit ng `SOUL.md` ng alternatibong persona).

To inspect how much each injected file contributes (raw vs injected, truncation, plus tool schema overhead), use `/context list` or `/context detail`. See [Context](/concepts/context).

## Time handling

The system prompt includes a dedicated **Current Date & Time** section when the
user timezone is known. To keep the prompt cache-stable, it now only includes
the **time zone** (no dynamic clock or time format).

Gamitin ang `session_status` kapag kailangan ng agent ang kasalukuyang oras; kasama sa status card
ang isang timestamp line.

I-configure gamit ang:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Tingnan ang [Date & Time](/date-time) para sa kumpletong detalye ng behavior.

## Skills

When eligible skills exist, OpenClaw injects a compact **available skills list**
(`formatSkillsForPrompt`) that includes the **file path** for each skill. The
prompt instructs the model to use `read` to load the SKILL.md at the listed
location (workspace, managed, or bundled). If no skills are eligible, the
Skills section is omitted.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Pinananatiling maliit nito ang base prompt habang pinapagana pa rin ang target na paggamit ng skill.

## Documentation

When available, the system prompt includes a **Documentation** section that points to the
local OpenClaw docs directory (either `docs/` in the repo workspace or the bundled npm
package docs) and also notes the public mirror, source repo, community Discord, and
ClawHub ([https://clawhub.com](https://clawhub.com)) for skills discovery. The prompt instructs the model to consult local docs first
for OpenClaw behavior, commands, configuration, or architecture, and to run
`openclaw status` itself when possible (asking the user only when it lacks access).

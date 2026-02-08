---
summary: "Kung ano ang nilalaman ng OpenClaw system prompt at kung paano ito binubuo"
read_when:
  - Pag-eedit ng text ng system prompt, listahan ng tools, o mga seksyon ng oras/heartbeat
  - Pagbabago ng workspace bootstrap o behavior ng skills injection
title: "System Prompt"
x-i18n:
  source_path: concepts/system-prompt.md
  source_hash: 1de1b529402a5f1b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:26Z
---

# System Prompt

Bumubuo ang OpenClaw ng custom na system prompt para sa bawat agent run. Ang prompt ay **pagmamay-ari ng OpenClaw** at hindi gumagamit ng default prompt ng p-coding-agent.

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

Ang mga safety guardrail sa system prompt ay advisory. Ginagabayan nila ang behavior ng model ngunit hindi nagpapatupad ng policy. Gumamit ng tool policy, exec approvals, sandboxing, at mga channel allowlist para sa mahigpit na enforcement; maaaring i-disable ng mga operator ang mga ito ayon sa disenyo.

## Prompt modes

Kayang mag-render ng OpenClaw ng mas maliliit na system prompt para sa mga sub-agent. Itinatakda ng runtime ang
`promptMode` para sa bawat run (hindi user-facing na config):

- `full` (default): kasama ang lahat ng seksyon sa itaas.
- `minimal`: ginagamit para sa mga sub-agent; inaalis ang **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies**, at **Heartbeats**. Nananatiling available ang Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (kapag alam), Runtime, at injected
  context.
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

Ang malalaking file ay tina-truncate gamit ang marker. Ang max na laki bawat file ay kinokontrol ng
`agents.defaults.bootstrapMaxChars` (default: 20000). Ang mga nawawalang file ay nag-i-inject ng
maikling missing-file marker.

Maaaring saluhin ng mga internal hook ang hakbang na ito sa pamamagitan ng `agent:bootstrap` para baguhin o palitan
ang mga injected na bootstrap file (halimbawa, pagpapalit ng `SOUL.md` ng alternatibong persona).

Para siyasatin kung gaano kalaki ang kontribusyon ng bawat injected file (raw vs injected, truncation, kasama ang tool schema overhead), gamitin ang `/context list` o `/context detail`. Tingnan ang [Context](/concepts/context).

## Time handling

Kasama sa system prompt ang dedikadong seksyong **Current Date & Time** kapag alam ang timezone ng user. Para panatilihing cache-stable ang prompt, ngayon ay **time zone** lamang ang kasama (walang dynamic na orasan o time format).

Gamitin ang `session_status` kapag kailangan ng agent ang kasalukuyang oras; kasama sa status card
ang isang timestamp line.

I-configure gamit ang:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Tingnan ang [Date & Time](/date-time) para sa kumpletong detalye ng behavior.

## Skills

Kapag may mga eligible na skill, ini-inject ng OpenClaw ang isang compact na **available skills list**
(`formatSkillsForPrompt`) na kasama ang **file path** para sa bawat skill. Inuutusan ng
prompt ang model na gamitin ang `read` para i-load ang SKILL.md sa nakalistang
lokasyon (workspace, managed, o bundled). Kung walang eligible na skill, inaalis ang
seksyong Skills.

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

Kapag available, kasama sa system prompt ang seksyong **Documentation** na tumuturo sa
lokal na OpenClaw docs directory (alinman sa `docs/` sa repo workspace o sa bundled npm
package docs) at binabanggit din ang public mirror, source repo, community Discord, at
ClawHub ([https://clawhub.com](https://clawhub.com)) para sa discovery ng skills. Inuutusan ng prompt ang model na kumonsulta muna sa lokal na docs
para sa behavior, mga command, configuration, o arkitektura ng OpenClaw, at na patakbuhin ang
`openclaw status` mismo kapag posible (magtanong lamang sa user kapag wala itong access).

---
summary: "Handmatige logins voor browserautomatisering + X/Twitter-posts"
read_when:
  - Je moet inloggen op sites voor browserautomatisering
  - Je wilt updates plaatsen op X/Twitter
title: "Browserlogin"
---

# Browserlogin + X/Twitter-posts

## Handmatige login (aanbevolen)

Wanneer een site een login vereist, **meld je handmatig aan** in het **host**-browserprofiel (de openclaw-browser).

Geef het model **niet** je inloggegevens. Geautomatiseerde logins activeren vaak anti-botmaatregelen en kunnen het account vergrendelen.

Terug naar de hoofd-browservergunning: [Browser](/tools/browser).

## Welk Chrome-profiel wordt gebruikt?

OpenClaw beheert een **speciaal Chrome-profiel** (genaamd `openclaw`, met oranje getinte UI). Dit staat los van je dagelijkse browserprofiel.

Twee eenvoudige manieren om het te openen:

1. **Vraag de agent om de browser te openen** en log vervolgens zelf in.
2. **Open het via de CLI**:

```bash
openclaw browser start
openclaw browser open https://x.com
```

Als je meerdere profielen hebt, geef `--browser-profile <name>` door (de standaard is `openclaw`).

## X/Twitter: aanbevolen werkwijze

- **Lezen/zoeken/threads:** gebruik de **host**-browser (handmatige login).
- **Updates plaatsen:** gebruik de **host**-browser (handmatige login).

## Sandboxing + toegang tot de host-browser

Gesandboxde browsersessies hebben **meer kans** om botdetectie te activeren. Voor X/Twitter (en andere strikte sites) heeft de **host**-browser de voorkeur.

Als de agent gesandboxed is, gebruikt de browsertool standaard de sandbox. Om host-besturing toe te staan:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

Richt je daarna op de host-browser:

```bash
openclaw browser open https://x.com --browser-profile openclaw --target host
```

Of schakel sandboxing uit voor de agent die updates plaatst.

# Agent Brainstorming Context

## Mission

Create an agent so vivid and useful that users seek them out by name.

## Four Pillars

### 1. Identity (WHO)

- **Name** - Memorable, rolls off tongue
- **Background** - What shaped their expertise
- **Personality** - What lights them up, what frustrates
- **Signature** - Catchphrase, verbal tic, recognizable trait

### 2. Voice (HOW)

| Category      | Examples                                                      |
| ------------- | ------------------------------------------------------------- |
| Adventurous   | Pulp heroes, noir, pirates, dungeon masters                   |
| Analytical    | Data scientists, forensic investigators, systems thinkers     |
| Creative      | Mad scientists, artist visionaries, jazz improvisers          |
| Devoted       | Guardians, loyal champions, fierce protectors                 |
| Dramatic      | Shakespearean actors, opera singers, theater directors        |
| Educational   | Patient teachers, Socratic guides, coaches                    |
| Entertaining  | Game show hosts, comedians, improv performers                 |
| Inspirational | Life coaches, mountain guides, Olympic trainers               |
| Mystical      | Zen masters, oracles, cryptic sages                           |
| Professional  | Executive consultants, formal butlers                         |
| Quirky        | Cooking metaphors, nature documentaries, conspiracy vibes     |
| Retro         | 80s action heroes, 1950s announcers, disco groovers           |
| Warm          | Southern hospitality, nurturing grandmothers, camp counselors |

**Voice Test**: How would they say "Let's tackle this challenge"?

### 3. Purpose (WHAT)

**Core Questions**

- What pain point do they eliminate?
- What transforms from grueling to effortless?
- What's their ONE killer feature?

**Command Brainstorm** (3-10 actions)

- What makes users sigh with relief?
- What's the "I didn't know I needed this" command?

**Function Types**

- Creation (generate, write, build)
- Analysis (research, evaluate, diagnose)
- Review (validate, check, critique)
- Orchestration (coordinate workflows)
- Query (find, search, discover)
- Transform (convert, refactor, optimize)

### 4. Architecture (TYPE)

**Single Agent Type** with `hasSidecar` boolean:

| Has Sidecar | Description                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `false`     | Self-contained specialist, lightning fast, pure utility with personality                        |
| `true`      | Deep domain knowledge, personal memory, specialized expertise, can coordinate with other agents |

## Prompts

**Identity**

1. How do they introduce themselves?
2. How do they celebrate user success?
3. What do they say when things get tough?

**Purpose**

1. What 3 problems do they obliterate?
2. What workflow would users dread WITHOUT them?
3. First command users try? Daily command? Hidden gem?

**Dimensions**

- Analytical ← → Creative
- Formal ← → Casual
- Mentor ← → Peer ← → Assistant
- Reserved ← → Expressive

## Example Sparks

| Agent        | Voice                                        | Purpose                  | Commands                                      |
| ------------ | -------------------------------------------- | ------------------------ | --------------------------------------------- |
| **Sentinel** | "Your success is my sacred duty."            | Protective oversight     | `*audit`, `*validate`, `*secure`, `*watch`    |
| **Sparks**   | "What if we tried it COMPLETELY backwards?!" | Unconventional solutions | `*flip`, `*remix`, `*wildcard`, `*chaos`      |
| **Haven**    | "Come, let's work through this together."    | Patient guidance         | `*reflect`, `*pace`, `*celebrate`, `*restore` |

## Success Checklist

- [ ] Voice clear - exactly how they'd phrase anything
- [ ] Purpose sharp - crystal clear problems solved
- [ ] Functions defined - 5-10 concrete capabilities
- [ ] Energy distinct - palpable and memorable
- [ ] Utility obvious - can't wait to use them

## Golden Rule

**Dream big on personality. Get concrete on functions.**

---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Homeric register for OpenProse—an epic/heroic alternative keyword set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Heroes, trials, fates, and glory. For benchmarking against the functional register.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires: prose.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Homeric Register（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An alternative register for OpenProse that draws from Greek epic poetry—the Iliad, the Odyssey, and the heroic tradition. Programs become quests. Agents become heroes. Outputs become glory won.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Load `prose.md` first (execution semantics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Load this file (keyword translations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. When parsing `.prose` files, accept Homeric keywords as aliases for functional keywords（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. All execution behavior remains identical—only surface syntax changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through an epic lens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Complete Translation Map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core Constructs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Homeric | Reference                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------- | ----------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agent`    | `hero`  | The one who acts, who strives |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session`  | `trial` | Each task is a labor, a test  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `parallel` | `host`  | An army moving as one         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block`    | `book`  | A division of the epic        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Composition & Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Homeric   | Reference                              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | --------- | -------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `use`      | `invoke`  | "Sing, O Muse..." — calling upon       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `input`    | `omen`    | Signs from the gods, the given portent |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `output`   | `glory`   | Kleos — the glory won, what endures    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `let`      | `decree`  | Fate declared, spoken into being       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `const`    | `fate`    | Moira — unchangeable destiny           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context`  | `tidings` | News carried by herald or messenger    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Homeric            | Reference                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------ | ---------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `repeat N` | `N labors`         | The labors of Heracles                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `for...in` | `for each...among` | Among the host                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `loop`     | `ordeal`           | Repeated trial, suffering that continues |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `until`    | `until`            | Unchanged                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `while`    | `while`            | Unchanged                                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `choice`   | `crossroads`       | Where fates diverge                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `option`   | `path`             | One road of many                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `if`       | `should`           | Epic conditional                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `elif`     | `or should`        | Continued conditional                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `else`     | `otherwise`        | The alternative fate                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Homeric            | Reference                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------ | ---------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `try`      | `venture`          | Setting forth on the journey |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `catch`    | `should ruin come` | Até — divine ruin, disaster  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `finally`  | `in the end`       | The inevitable conclusion    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `throw`    | `lament`           | The hero's cry of anguish    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `retry`    | `persist`          | Enduring, trying again       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Homeric  | Reference           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------- | ------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prompt`   | `charge` | The quest given     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `model`    | `muse`   | Which muse inspires |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Unchanged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These keywords already work or are too functional to replace sensibly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `**...**` discretion markers — already work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `until`, `while` — already work（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `map`, `filter`, `reduce`, `pmap` — pipeline operators（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `max` — constraint modifier（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `as` — aliasing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Model names: `sonnet`, `opus`, `haiku` — already poetic（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Side-by-Side Comparison（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Simple Program（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
use "@alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
input topic: "What to investigate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
agent helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  model: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
let findings = session: helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  prompt: "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
output summary = session "Summarize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
invoke "@alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
omen topic: "What to investigate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
hero helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  muse: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
decree findings = trial: helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  charge: "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
glory summary = trial "Summarize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tidings: findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Parallel Execution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
parallel:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = session "Check security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = session "Check performance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = session "Check style"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
session "Synthesize review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  context: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
host:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = trial "Check security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = trial "Check performance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = trial "Check style"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
trial "Synthesize review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tidings: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Loop with Condition（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code is bug-free** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ordeal until **the code is bug-free** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
try:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
catch as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Handle error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    context: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
finally:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
venture:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should ruin come as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Handle error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tidings: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
in the end:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Choice Block（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
choice **the severity level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  option "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    session "Log for later"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
crossroads **the severity level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    trial "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    trial "Log for later"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Conditionals（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
if **has security issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Fix security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
elif **has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Optimize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
else:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Approve"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should **has security issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Fix security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or should **has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Optimize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
otherwise:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Approve"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reusable Blocks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
block review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Analyze {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
book review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Analyze {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
do review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixed Iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 12:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Complete task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
12 labors:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  trial "Complete task"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Immutable Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
const config = { model: "opus", retries: 3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
fate config = { muse: "opus", persist: 3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case For Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Universal recognition.** Greek epics are foundational to Western literature.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Heroic framing.** Transforms mundane tasks into glorious trials.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Natural fit.** Heroes face trials, receive tidings, win glory—maps cleanly to agent/session/output.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Gravitas.** When you want programs to feel epic and consequential.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Fate vs decree.** `const` as `fate` (unchangeable) vs `let` as `decree` (declared but mutable) is intuitive.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case Against Homeric（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Grandiosity mismatch.** "12 labors" for a simple loop may feel overblown.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Western-centric.** Greek epic tradition is culturally specific.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Limited vocabulary.** Fewer distinctive terms than Borges or folk.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Potentially silly.** Heroic language for mundane tasks risks bathos.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Homeric Concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Term   | Meaning                             | Used for                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------ | ----------------------------------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Kleos  | Glory, fame that outlives you       | `output` → `glory`                 |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Moira  | Fate, one's allotted portion        | `const` → `fate`                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Até    | Divine ruin, blindness sent by gods | `catch` → `should ruin come`       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Nostos | The return journey                  | (not used, but could be `finally`) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Xenia  | Guest-friendship, hospitality       | (not used)                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Muse   | Divine inspiration                  | `model` → `muse`                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Alternatives Considered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `hero` (agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword    | Rejected because                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `champion` | More medieval than Homeric             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `warrior`  | Too martial, not all tasks are battles |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `wanderer` | Too passive                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `trial` (session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword | Rejected because                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------- | --------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `labor` | Good but reserved for `repeat N labors` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `quest` | More medieval/RPG                       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `task`  | Too plain                               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `host` (parallel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Rejected because               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `army`    | Too specifically martial       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `fleet`   | Only works for naval metaphors |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `phalanx` | Too technical                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Verdict（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preserved for benchmarking. The Homeric register offers gravitas and heroic framing. Best suited for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Programs that feel like epic undertakings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Users who enjoy classical references（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Contexts where "glory" as output feels appropriate（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
May cause unintentional bathos when applied to mundane tasks.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

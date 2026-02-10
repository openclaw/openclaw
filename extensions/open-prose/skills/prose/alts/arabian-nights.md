---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Arabian Nights register for OpenProse—a narrative/nested alternative keyword set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Djinns, tales within tales, wishes, and oaths. For benchmarking against the functional register.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires: prose.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Arabian Nights Register（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An alternative register for OpenProse that draws from One Thousand and One Nights. Programs become tales told by Scheherazade. Recursion becomes stories within stories. Agents become djinns bound to serve.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Load `prose.md` first (execution semantics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Load this file (keyword translations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. When parsing `.prose` files, accept Arabian Nights keywords as aliases for functional keywords（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. All execution behavior remains identical—only surface syntax changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident through a storytelling lens.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Complete Translation Map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core Constructs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Nights   | Reference                             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------- | ------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agent`    | `djinn`  | Spirit bound to serve, grants wishes  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session`  | `tale`   | A story told, a narrative unit        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `parallel` | `bazaar` | Many voices, many stalls, all at once |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block`    | `frame`  | A story that contains other stories   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Composition & Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Nights    | Reference                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | --------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `use`      | `conjure` | Summoning from elsewhere         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `input`    | `wish`    | What is asked of the djinn       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `output`   | `gift`    | What is granted in return        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `let`      | `name`    | Naming has power (same as folk)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `const`    | `oath`    | Unbreakable vow, sealed          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context`  | `scroll`  | What is written and passed along |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Nights             | Reference                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------ | ------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `repeat N` | `N nights`         | "For a thousand and one nights..."   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `for...in` | `for each...among` | Among the merchants, among the tales |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `loop`     | `telling`          | The telling continues                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `until`    | `until`            | Unchanged                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `while`    | `while`            | Unchanged                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `choice`   | `crossroads`       | Where the story forks                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `option`   | `path`             | One way the story could go           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `if`       | `should`           | Narrative conditional                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `elif`     | `or should`        | Continued conditional                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `else`     | `otherwise`        | The other telling                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Nights                     | Reference                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------------------------- | -------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `try`      | `venture`                  | Setting out on the journey |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `catch`    | `should misfortune strike` | The tale turns dark        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `finally`  | `and so it was`            | The inevitable ending      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `throw`    | `curse`                    | Ill fate pronounced        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `retry`    | `persist`                  | The hero tries again       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Nights    | Reference                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | --------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prompt`   | `command` | What is commanded of the djinn |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `model`    | `spirit`  | Which spirit answers           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
conjure "@alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
wish topic: "What to investigate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
djinn helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  spirit: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name findings = tale: helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  command: "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
gift summary = tale "Summarize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scroll: findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
bazaar:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = tale "Check security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = tale "Check performance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = tale "Check style"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tale "Synthesize review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scroll: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
telling until **the code is bug-free** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
venture:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should misfortune strike as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Handle error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scroll: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
and so it was:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
crossroads **the severity level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tale "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    tale "Log for later"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should **has security issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Fix security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or should **has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Optimize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
otherwise:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Approve"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Reusable Blocks (Frame Stories)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
frame review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Analyze {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
tell review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Fixed Iteration（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Functional（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
repeat 1001:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  session "Tell a story"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```prose（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1001 nights:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  tale "Tell a story"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
oath config = { spirit: "opus", persist: 3 }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case For Arabian Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Frame narrative is recursion.** Stories within stories maps perfectly to nested program calls.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Djinn/wish/gift.** The agent/input/output mapping is extremely clean.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Rich tradition.** One Thousand and One Nights is globally known.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Bazaar for parallel.** Many merchants, many stalls, all active at once—vivid metaphor.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Oath for const.** An unbreakable vow is a perfect metaphor for immutability.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **"1001 nights"** as a loop count is delightful.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case Against Arabian Nights（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Cultural sensitivity.** Must be handled respectfully, avoiding Orientalist tropes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **"Djinn" pronunciation.** Users unfamiliar may be uncertain (jinn? djinn? genie?).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Some mappings feel forced.** "Bazaar" for parallel is vivid but not obvious.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **"Should misfortune strike"** is long for `catch`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Key Arabian Nights Concepts（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Term         | Meaning                                 | Used for              |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | --------------------------------------- | --------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Scheherazade | The narrator who tells tales to survive | (the program author)  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Djinn        | Supernatural spirit, bound to serve     | `agent` → `djinn`     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Frame story  | A story that contains other stories     | `block` → `frame`     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Wish         | What is asked of the djinn              | `input` → `wish`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Oath         | Unbreakable promise                     | `const` → `oath`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Bazaar       | Marketplace, many vendors               | `parallel` → `bazaar` |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Alternatives Considered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `djinn` (agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword    | Rejected because                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ---------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `genie`    | Disney connotation, less literary  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `spirit`   | Used for `model`                   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `ifrit`    | Too specific (a type of djinn)     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `narrator` | Too meta, Scheherazade is the user |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `tale` (session)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Rejected because                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `story`   | Good but `tale` feels more literary |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `night`   | Reserved for `repeat N nights`      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `chapter` | More Western/novelistic             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `bazaar` (parallel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Rejected because                           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ------------------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `caravan` | Sequential connotation (one after another) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `chorus`  | Greek, wrong tradition                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `souk`    | Less widely known                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `scroll` (context)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Rejected because   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `letter`  | Too small/personal |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `tome`    | Too large          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `message` | Too plain          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Verdict（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preserved for benchmarking. The Arabian Nights register offers a storytelling frame that maps naturally to recursive, nested programs. The djinn/wish/gift trio is particularly elegant.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Best suited for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Programs with deep nesting (stories within stories)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Workflows that feel like granting wishes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Users who enjoy narrative framing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
The `frame` keyword for reusable blocks is especially apt—Scheherazade's frame story containing a thousand tales.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

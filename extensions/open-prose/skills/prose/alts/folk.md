---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
role: experimental（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Folk register for OpenProse—a literary/folklore alternative keyword set.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  Whimsical, theatrical, rooted in fairy tale and myth. For benchmarking（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  against the functional register.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
status: draft（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
requires: prose.md（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenProse Folk Register（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **This is a skin layer.** It requires `prose.md` to be loaded first. All execution semantics, state management, and VM behavior are defined there. This file only provides keyword translations.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
An alternative register for OpenProse that leans into literary, theatrical, and folklore terminology. The functional register prioritizes utility and clarity; the folk register prioritizes whimsy and narrative flow.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## How to Use（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. Load `prose.md` first (execution semantics)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Load this file (keyword translations)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. When parsing `.prose` files, accept folk keywords as aliases for functional keywords（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. All execution behavior remains identical—only surface syntax changes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
> **Design constraint:** Still aims to be "structured but self-evident" per the language tenets—just self-evident to a different sensibility.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Complete Translation Map（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Core Constructs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Folk       | Origin   | Connotation                            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ---------- | -------- | -------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `agent`    | `sprite`   | Folklore | Quick, light, ephemeral spirit helper  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `session`  | `scene`    | Theatre  | A moment of action, theatrical framing |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `parallel` | `ensemble` | Theatre  | Everyone performs together             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `block`    | `act`      | Theatre  | Reusable unit of dramatic action       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Composition & Binding（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Folk      | Origin            | Connotation                      |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | --------- | ----------------- | -------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `use`      | `summon`  | Folklore          | Calling forth from elsewhere     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `input`    | `given`   | Fairy tale        | "Given a magic sword..."         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `output`   | `yield`   | Agriculture/magic | What the spell produces          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `let`      | `name`    | Folklore          | Naming has power (true names)    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `const`    | `seal`    | Medieval          | Unchangeable, wax seal on decree |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `context`  | `bearing` | Heraldry          | What the messenger carries       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Control Flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Folk               | Origin       | Connotation                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ------------------ | ------------ | ----------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `repeat N` | `N times`          | Fairy tale   | "Three times she called..."         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `for...in` | `for each...among` | Narrative    | Slightly more storytelling          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `loop`     | `loop`             | —            | Already poetic, unchanged           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `until`    | `until`            | —            | Already works, unchanged            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `while`    | `while`            | —            | Already works, unchanged            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `choice`   | `crossroads`       | Folklore     | Fateful decisions at the crossroads |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `option`   | `path`             | Journey      | Which path to take                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `if`       | `when`             | Narrative    | "When the moon rises..."            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `elif`     | `or when`          | Narrative    | Continued conditional               |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `else`     | `otherwise`        | Storytelling | Natural narrative alternative       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Error Handling（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Folk             | Origin     | Connotation                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | ---------------- | ---------- | ------------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `try`      | `venture`        | Adventure  | Attempting something uncertain |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `catch`    | `should it fail` | Narrative  | Conditional failure handling   |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `finally`  | `ever after`     | Fairy tale | "And ever after..."            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `throw`    | `cry`            | Drama      | Raising alarm, calling out     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `retry`    | `persist`        | Quest      | Keep trying against odds       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Session Properties（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Functional | Folk     | Origin   | Connotation            |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ---------- | -------- | -------- | ---------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `prompt`   | `charge` | Chivalry | Giving a quest or duty |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `model`    | `voice`  | Theatre  | Which voice speaks     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Unchanged（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
These keywords already have poetic quality or are too functional to replace sensibly:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `**...**` discretion markers — already "breaking the fourth wall"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `loop`, `until`, `while` — already work narratively（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `map`, `filter`, `reduce`, `pmap` — pipeline operators, functional is fine（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summon "@alice/research" as research（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
given topic: "What to investigate"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
sprite helper:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  voice: sonnet（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name findings = scene: helper（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  charge: "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
yield summary = scene "Summarize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bearing: findings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ensemble:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  security = scene "Check security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  perf = scene "Check performance"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  style = scene "Check style"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scene "Synthesize review"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  bearing: { security, perf, style }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
loop until **the code is bug-free** (max: 5):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Find and fix bugs"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
venture:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Risky operation"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
should it fail as err:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Handle error"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    bearing: err（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ever after:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Cleanup"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
crossroads **the severity level**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Critical":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scene "Escalate immediately"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  path "Minor":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    scene "Log for later"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
when **has security issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Fix security"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
or when **has performance issues**:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Optimize"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
otherwise:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Approve"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
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
# Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
act review(topic):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Research {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  scene "Analyze {topic}"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
perform review("quantum computing")（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case For Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **"OpenProse" is literary.** Prose is a literary form—why not lean in?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Fourth wall is theatrical.** `**...**` already uses theatre terminology.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Signals difference.** Literary terms say "this is not your typical DSL."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Internally consistent.** Everything draws from folklore/theatre/narrative.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **Memorable.** `sprite`, `scene`, `crossroads` stick in the mind.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Model names already fit.** `sonnet`, `opus`, `haiku` are poetic forms.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## The Case Against Folk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Cultural knowledge required.** Not everyone knows folklore tropes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Harder to Google.** "OpenProse summon" vs "OpenProse import."（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **May feel precious.** Some users want utilitarian tools.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Translation overhead.** Mental mapping to familiar concepts.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Alternatives Considered（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `sprite` (ephemeral agent)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Origin  | Rejected because                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ------- | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `spark`   | English | Good but less folklore                    |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `wisp`    | English | Too insubstantial                         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `herald`  | English | More messenger than worker                |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `courier` | French  | Good functional alternative, not literary |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `envoy`   | French  | Formal, diplomatic                        |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `shade` (persistent agent, if implemented)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Origin     | Rejected because                  |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ---------- | --------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `daemon`  | Greek/Unix | Unix "always running" connotation |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `oracle`  | Greek      | Too "read-only" feeling           |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `spirit`  | Latin      | Too close to `sprite`             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `specter` | Latin      | Negative/spooky connotation       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `genius`  | Roman      | Overloaded (smart person)         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `ensemble` (parallel)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword   | Origin  | Rejected because                          |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| --------- | ------- | ----------------------------------------- |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `chorus`  | Greek   | Everyone speaks same thing, not different |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `troupe`  | French  | Good alternative, slightly less clear     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `company` | Theatre | Overloaded (business)                     |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### For `crossroads` (choice)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| Keyword      | Origin | Rejected because         |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| ------------ | ------ | ------------------------ |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `fork`       | Path   | Too technical (git fork) |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `branch`     | Tree   | Also too technical       |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
| `divergence` | Latin  | Too abstract             |（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Verdict（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Preserved for benchmarking against the functional register. The functional register remains the primary path, but folk provides an interesting data point for:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Learnability** — Which is easier for newcomers?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Memorability** — Which sticks better?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Error rates** — Which leads to fewer mistakes?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Preference** — Which do users actually prefer?（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
A future experiment could present both registers and measure outcomes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

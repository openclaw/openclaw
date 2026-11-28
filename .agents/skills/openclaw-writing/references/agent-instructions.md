# Agent instruction files

Reference for `AGENTS.md` files, skills, and review prompts. The reader is a model that runs the document again on every task, so the aim is that it takes the same process each time.

## Instruction rules

These are the repository's rules for adding a rule.

- A new rule cites an incident: a PR, issue or commit. No incident, no rule.
- A new rule passes the deletion test: without it, a senior engineer does the wrong thing.
- A rule has no "unless security, data or money" exception. Name the exact failure.
- A proof or test demand names the real input and the wrong result. For a speculative race, ask only for the failure mode and its likelihood.
- A rule added in one layer deletes its looser and stricter copies in the other layers in the same PR.

## Where a rule lives

- Each rule has one owner: the nearest scoped `AGENTS.md` or the skill for that work. Other files point to it.
- The root `AGENTS.md` stays under 20,000 characters, the size OpenClaw loads whole. A long rule goes in the owning guide, and the root keeps a one-line pointer. Count with `wc -m AGENTS.md`.
- Read the root and the nearest scoped `AGENTS.md` before editing either, and write down any instruction that conflicts with yours.
- Name real commands and real paths, and confirm that each one exists.

## Pointers

A pointer is a line the agent always has in context that names material it does not: a skill's description, or an `AGENTS.md` line that links a guide. Its wording decides when the agent reads the material.

- Say what the material is, then list the cases that should send the agent to it.
- Put the triggering word first.
- Give each case one trigger. Two phrasings of one case are one case.
- Leave out what the target already says about itself.

## Structure

- Separate steps (what the agent does, in order) from reference (what it consults).
- Keep in the main file what every case needs. Move what only some cases need into a file behind a pointer.
- Keep a concept's definition, rules, and caveats under one heading.
- End every step with a completion criterion the agent can check, and make it demand the full job: “every changed string checked” asks for more work than “strings reviewed”.
- When a step gets rushed because later steps are in view, sharpen its criterion first.

## Words

- State the target behavior: “write one-line comments”. A prohibition names the unwanted behavior and brings it to mind, so keep one only as a hard guardrail and pair it with the behavior you want.
- Reuse one compact word for a recurring idea, and prefer a word the model already knows over a coined one.
- Follow the [sentence rules](sentences.md) for voice and concision.

## Pruning

- Keep each meaning in one place.
- Let the environment answer what it can: `package.json` scripts, config files, directory layout, `--help` output. Write down what a reader cannot find by looking: the convention, the reason, the trap.
- Delete a sentence the model would obey without being told.
- Delete a line that no longer bears on what the document does.

## Skills

- A skill is a folder under `.agents/skills/` with a `SKILL.md` whose front matter has `name` and `description`.
- The description is the skill's pointer and is always loaded. Write it for the model, with one trigger per case.
- Keep `SKILL.md` short. Reference material goes in sibling files that the main file points to.

## Checks

- Every path, command, and link in the file resolves.
- The root `AGENTS.md` is under 20,000 characters.
- A changed rule has no second copy in another layer.

# UMLs (PlantUML)

Source diagrams live as `.puml` files in this directory. Rendered **SVG** files are committed next to
them so Mintlify and GitHub can show them without a PlantUML runtime.

## Render locally

From the repository root:

```bash
scripts/render-docs-umls.sh
```

Or a single file:

```bash
scripts/render-docs-umls.sh docs/UMLs/chat-inbound-reply-sequence.puml
```

Requirements:

- **`plantuml` on your `PATH`**, or
- **`PLANTUML_JAR`** pointing at `plantuml.jar` (the script will run `java -jar ...`).

Some diagram types need **Graphviz (`dot`)**. **Sequence diagrams** usually render without it; if
PlantUML warns that `dot` is missing, install Graphviz for your platform or ignore the warning when
you only maintain sequence diagrams here.

## Related doc page

- [Inbound chat reply sequence](/UMLs/chat-inbound-reply-sequence) — narrative plus embedded SVG

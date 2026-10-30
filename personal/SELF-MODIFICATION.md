# Self-Modification & Skill Creation

The core philosophy of this instance is limitless capability, which implies an ability for the system to build tools it doesn't have.

## Skill Workshop

If a skill is missing, OpenClaw can build its own plugins via the `openclaw-superpowers` skill and the `agent-builder` UI.
- Use `openclaw agents` CLI to generate new agent scaffolds.
- AceForge can be used to scaffold complex extensions or RAG flows.
- Moltron evaluates custom agents before adding them to the primary configuration.

## Protocol for Missing Tools
1. Research existing open-source materials.
2. If none exist or they compromise security (e.g. cloud requirement, data harvesting), design and build the missing part locally using Python/Node.js or bash.
3. Test within the native OpenClaw sandbox.
4. Promote to an active tool if passing tests.

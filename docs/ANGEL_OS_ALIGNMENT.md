# Angel OS alignment and strategy

This document describes how **Angel OS** relates to OpenClaw and provides enough context for contributors and downstream forks. No change to OpenClaw runtime behavior is implied. It is intended as a testable blueprint for the foundation of **AngelClaw**’s future platform on Clearwater.

## What is Angel OS?

**Angel OS** = OpenClaw + adoption of the **Angel OS Constitution**. OpenClaw is the conversation and interface layer; **Angel OS Core** (Payload CMS) is the backend and config store. The Constitution is the single path that ties everything together. Minimal changes to OpenClaw and to the Seed constitution are intended—alignment is achieved through the Constitution first.

**Canonical Constitution:** [Angel OS Constitution](https://github.com/The-Angel-OS/angels-os/blob/main/docs/Angel_OS_Constitution.md) (Angel OS repo).  
A minimal **Seed**—the set of principles OpenClaw commits to when running as Angel OS—is summarized in [ANGEL_OS_CONSTITUTION_SEED](ANGEL_OS_CONSTITUTION_SEED) in this repo.

A longer-term goal is an **immutable seed prompt**—a stable constitutional core—with content and governance open for discussion and refinement (in line with Answer 53).

## Strategy summary

- **Per-Angel model:** Individual LEOs per Angel; CMS (Angel OS Core) is local to each. Angel OS Core uses the same AI Bus internally. Each Angel is admin of their tenant, spaces, and users.
- **Roadmap:** Blockchain and missing architecture; board and organization per Constitution. Future: 800 numbers per Angel, Nimue-style routing (e.g. 1-800-Angels), VAPI/Twilio.
- **Vision path:** Constitution → Soul Fleet → San Dimas / Bill & Ted (“Be excellent to each other. Party on, dudes!”) → Star Trek (“Live long and prosper”)—peaceful, meaningful transition and great awakening.

## References

| Item                              | Location                                                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Angel OS Core (Payload)           | [github.com/The-Angel-OS/angels-os](https://github.com/The-Angel-OS/angels-os)                                               |
| Angel OS Constitution (canonical) | [angels-os/docs/Angel_OS_Constitution.md](https://github.com/The-Angel-OS/angels-os/blob/main/docs/Angel_OS_Constitution.md) |
| OpenClaw (upstream)               | OpenClaw org repo                                                                                                            |
| Angel OS fork of OpenClaw         | The-Angel-OS fork of OpenClaw                                                                                                |

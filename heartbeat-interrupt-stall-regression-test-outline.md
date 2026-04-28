# Heartbeat interrupt stall, regression test outline

## Target behavior

Interrupting heartbeat/system events must not strand the original main-session user task without a final user-visible reply.

## Test case 1

### Name

main-session task survives heartbeat interrupt

### Shape

- start a user task in main session
- simulate in-flight work
- inject heartbeat prompt
- ensure heartbeat handling does not permanently replace the original task outcome
- assert final user-visible completion still happens

## Test case 2

### Name

main-session task survives exec-completion system event interrupt

### Shape

- start a user task in main session
- inject `Exec completed (...)` system event while work is active
- assert original task still reaches final reply

## Test case 3

### Name

stale pending delivery does not leak across unrelated main-session turns

### Shape

- create interrupted turn A
- finish turn B later
- ensure any durable final-delivery state from A does not leak into B

## Test case 4

### Name

heartbeat defers while active user-directed work exists

### Shape

- simulate active tool-backed user turn
- attempt heartbeat run
- assert defer/skip path
- assert original task retains ownership of final reply path

## Why these tests matter

They cover:

- direct heartbeat interrupt
- exec/system-event interrupt
- stale state isolation
- mitigation path for heartbeat suppression

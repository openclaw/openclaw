# SKILL: SOLANA ANCHOR ELITE (CLEAN CODE)

Principles for writing maintainable, minimal, and elite Anchor code.

## CLEAN CODE MANDATE

- **"Deletionist" Mindset**: If a line of code is not strictly necessary for security or functionality, delete it.
- **Understandable Code**: Avoid obscure Rust macros where standard implementations suffice.
- **Naming**: Use descriptive, context-rich variable names. `user_vault` NOT `uv`.

## SUCCESS CRITERIA

- **Passing Tests**: Success is ONLY achieved when 100% of integration tests pass.
- **Zero Magic Numbers**: All constants must be defined as named constants with explanatory comments.

## GEMINI THINKING PROTOCOL
>
> [!IMPORTANT]
> Use your thinking process to analyze the "Chain of Command" for every instruction:
>
> - Who creates the account?
> - Who signs the transaction?
> - What happens if the input is `0` or `null`?

## DEPLOYMENT & VERIFICATION

- **Verifiable Builds**: You MUST use the `solana-verify-build` skill when compiling and deploying the program to ensure reproducibility.
- **IDL Syncing**: Ensure the on-chain Interface Definition Language (IDL) is always synchronized with the verified build. Run `anchor idl init` or `anchor idl upgrade` *after* a successful verifiable deployment.

## ARCHITECTURE

- **Instruction Handlers**: Extract logic into standalone handler functions.
- **Account Structs**: Use distinct files for complex account definitions.
- **CPI**: Always verify the correct program ID when performing Cross-Program Invocations.

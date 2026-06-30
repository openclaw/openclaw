# Proof harness image for PR #97845 (streamed invoke recognizer grammar-drift fix).
#
# The image only needs a TypeScript runner: the package under test
# (packages/tool-call-repair) is pure TypeScript with no external dependencies,
# and the repository is bind-mounted at /work at run time (see run-proof.sh).
# Pinned to the tsx version the repository already uses.
FROM node:22-slim

RUN npm install -g tsx@4.22.3

WORKDIR /work

# The repo root is mounted at /work; the harness reads the package source from
# there, builds the BEFORE scratch copy in a temp dir, and writes captured output
# back under proof/pr-97845/output.
ENTRYPOINT ["tsx", "proof/pr-97845/harness.ts"]

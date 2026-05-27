import { describe, expect, it } from "vitest";
import { classifyNativeCommandSideEffect } from "./native-command-side-effects.js";

describe("classifyNativeCommandSideEffect", () => {
  it.each([
    "jq '.agents | keys' ~/.openclaw/openclaw.json",
    `/bin/zsh -lc "jq '.agents | keys' ~/.openclaw/openclaw.json"`,
    'rg -n "lastToolError" src',
    "ls ~/.openclaw/skills",
    "find src -name '*.ts'",
    "sed -n '1,80p' src/file.ts",
    "git status --short",
    "git -C /repo diff -- src/file.ts",
    "git branch --show-current",
  ])("classifies read-only diagnostic command as non-mutating: %s", (command) => {
    expect(classifyNativeCommandSideEffect(command)).toBe("readOnlyDiagnostic");
  });

  it.each([
    "jq . file.json > out.json",
    "tee file.txt",
    "find . -delete",
    "find . -exec rm {} \\;",
    "sed -i '' 's/a/b/' file.txt",
    "rm -rf dist",
    "mv a b",
    "touch file.txt",
    "git checkout -- file.txt",
    "git reset --hard",
    "pnpm install",
    "node -e \"require('fs').writeFileSync('x', 'y')\"",
    "curl -X POST https://example.test",
  ])("defaults mutating or ambiguous command to warning-relevant: %s", (command) => {
    expect(classifyNativeCommandSideEffect(command)).toBe("mutatingOrUnknown");
  });
});

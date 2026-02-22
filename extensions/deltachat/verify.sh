#!/bin/bash

echo "=== Delta.Chat Extension Verification ==="
echo ""

# Check all required files exist
echo "Checking files..."
FILES=(
  "index.ts"
  "package.json"
  "openclaw.plugin.json"
  "README.md"
  "CHANGELOG.md"
  "IMPLEMENTATION_SUMMARY.md"
  "tsconfig.json"
  "src/accounts.ts"
  "src/actions.ts"
  "src/channel.ts"
  "src/config-schema.ts"
  "src/index.ts"
  "src/monitor.ts"
  "src/onboarding.ts"
  "src/outbound.ts"
  "src/probe.ts"
  "src/runtime.ts"
  "src/send.ts"
  "src/targets.ts"
  "src/types.ts"
)

MISSING=0
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "✓ $file"
  else
    echo "✗ $file (MISSING)"
    MISSING=$((MISSING + 1))
  fi
done

echo ""
echo "Total files: ${#FILES[@]}"
echo "Missing files: $MISSING"

if [ $MISSING -eq 0 ]; then
  echo ""
  echo "✓ All files present!"
  echo ""
  echo "Checking TypeScript compilation..."
  npx tsc --noEmit --skipLibCheck 2>&1
  if [ $? -eq 0 ]; then
    echo "✓ TypeScript compilation successful!"
  else
    echo "✗ TypeScript compilation failed"
  fi
else
  echo ""
  echo "✗ Some files are missing. Please check the implementation."
fi

echo ""
echo "=== Verification Complete ==="

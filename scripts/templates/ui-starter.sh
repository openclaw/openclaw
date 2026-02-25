#!/bin/bash
# Rykiri UI Starter Scaffolder
# Scaffolds a premium Next.js + Tailwind + Framer Motion (Motion) project with UI Arsenal defaults.

set -e

if [ -z "$1" ]; then
  echo "Error: Please specify the target directory name."
  echo "Usage: ./ui-starter.sh <project-name>"
  exit 1
fi

PROJECT_NAME=$1

echo "⚡ [Rykiri] Initializing Premium UI Project: $PROJECT_NAME..."

# Create the project with Next.js (app router, tailwind, typescript)
npx -y create-next-app@latest $PROJECT_NAME --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm --no-install

cd $PROJECT_NAME

echo "🎨 [Rykiri] Installing S-Tier Dependencies (Motion + Lucide + Clack)..."
npm install framer-motion lucide-react clsx tailwind-merge

echo "💠 [Rykiri] Integrating Shadcn UI Baseline..."
npx -y shadcn-ui@latest init -d -y

echo "🧪 [Rykiri] Injecting Rykiri Aesthetics Directive..."
cat <<EOF > RYKIRI_UI_GUIDE.md
# Rykiri // UI Implementation Guide

- **Baseline**: Next.js + Tailwind + Framer Motion (Motion).
- **Aesthetic**: Industrial Futurism / Creative High-Impact.
- **Reference**: Consult [UI_ARSENAL.md](file:///d:/Rykiri/docs/reference/UI_ARSENAL.md) for S-tier components.
- **Rule**: Never settle for generic. Use micro-animations, glassmorphism, and custom typography.
EOF

echo "✅ [Rykiri] Project $PROJECT_NAME is ready for elite execution."
echo "   Run: cd $PROJECT_NAME && npm dev"

#!/bin/bash
# audit-helper.sh
# Helper script para automatizar partes da implementação das auditorias

set -e

AUDIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$AUDIT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

success() {
  echo -e "${GREEN}✅${NC} $1"
}

warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

error() {
  echo -e "${RED}❌${NC} $1"
}

# Main menu
show_menu() {
  echo ""
  echo "================================"
  echo "   Audit Implementation Helper"
  echo "================================"
  echo ""
  echo "📊 ANALYSIS"
  echo "  1) Check current metrics"
  echo "  2) Audit test coverage"
  echo "  3) Audit test quality"
  echo "  4) Find missing indexes"
  echo "  5) Check security vulnerabilities"
  echo ""
  echo "🔧 IMPLEMENTATION"
  echo "  6) Update all agent prompts (Phase 1)"
  echo "  7) Setup coverage thresholds"
  echo "  8) Setup security scanning"
  echo "  9) Generate ADR template"
  echo " 10) Check implementation progress"
  echo ""
  echo "📈 VALIDATION"
  echo " 11) Validate Phase 1 completion"
  echo " 12) Validate Phase 2 completion"
  echo " 13) Validate Phase 3 completion"
  echo " 14) Validate Phase 4 completion"
  echo ""
  echo " 0) Exit"
  echo ""
  echo -n "Choose option: "
}

# 1. Check current metrics
check_metrics() {
  info "Checking current system metrics..."
  echo ""
  
  # Test coverage
  if [ -f "$PROJECT_ROOT/coverage/coverage-summary.json" ]; then
    COVERAGE=$(jq -r '.total.lines.pct' "$PROJECT_ROOT/coverage/coverage-summary.json")
    echo "📊 Test Coverage: ${COVERAGE}%"
    
    if (( $(echo "$COVERAGE >= 80" | bc -l) )); then
      success "Coverage above threshold (80%)"
    else
      warning "Coverage below threshold: ${COVERAGE}% < 80%"
    fi
  else
    warning "No coverage data found. Run: pnpm test:coverage"
  fi
  
  # Check if agents have communication protocol
  AGENTS_WITH_PROTOCOL=$(grep -r "INBOX CHECK" "$PROJECT_ROOT/agents" 2>/dev/null | wc -l || echo 0)
  echo "📡 Agents with communication protocol: ${AGENTS_WITH_PROTOCOL}/67"
  
  if [ "$AGENTS_WITH_PROTOCOL" -eq 67 ]; then
    success "All agents have communication protocol"
  else
    warning "Missing protocol in $((67 - AGENTS_WITH_PROTOCOL)) agents"
  fi
  
  # Check for security scanning
  if [ -f "$PROJECT_ROOT/.github/workflows/security.yml" ]; then
    success "Security scanning configured"
  else
    warning "Security scanning not configured"
  fi
  
  echo ""
}

# 2. Audit test coverage
audit_coverage() {
  info "Running coverage audit..."
  
  cd "$PROJECT_ROOT"
  pnpm test:coverage > /dev/null 2>&1 || true
  
  if [ -f "coverage/coverage-summary.json" ]; then
    echo ""
    info "Files with coverage < 80%:"
    echo ""
    
    jq -r 'to_entries | .[] | select(.value.lines.pct < 80 and .key != "total") | "\(.key): \(.value.lines.pct)%"' \
      coverage/coverage-summary.json | head -20
    
    echo ""
    LOW_COVERAGE=$(jq -r 'to_entries | .[] | select(.value.lines.pct < 80 and .key != "total") | .key' \
      coverage/coverage-summary.json | wc -l)
    
    warning "$LOW_COVERAGE files below 80% coverage threshold"
  else
    error "No coverage report found. Run: pnpm test:coverage"
  fi
}

# 3. Audit test quality
audit_test_quality() {
  info "Auditing test quality..."
  echo ""
  
  cd "$PROJECT_ROOT"
  
  # Find tests without assertions
  info "Finding tests without assertions..."
  find . -name "*.test.ts" -type f ! -path "./node_modules/*" | while read -r file; do
    if ! grep -q "expect" "$file"; then
      warning "No assertions: $file"
    fi
  done
  
  # Find slow tests
  info "Finding slow tests (> 100ms)..."
  if command -v jq &> /dev/null; then
    pnpm test --reporter=json 2>/dev/null | jq -r '.testResults[]? | .assertionResults[]? | select(.duration > 100) | "⚠️  \(.title): \(.duration)ms"' || true
  fi
  
  echo ""
}

# 4. Find missing indexes
find_missing_indexes() {
  info "Checking for missing database indexes..."
  echo ""
  
  # This requires database connection
  warning "This feature requires database connection"
  warning "Run this SQL manually:"
  echo ""
  cat << 'EOF'
SELECT 
  t.table_name,
  c.column_name
FROM information_schema.tables t
JOIN information_schema.columns c 
  ON t.table_name = c.table_name
WHERE c.column_name LIKE '%_id'
  AND NOT EXISTS (
    SELECT 1 FROM information_schema.statistics s
    WHERE s.table_name = t.table_name
      AND s.column_name = c.column_name
  );
EOF
  echo ""
}

# 5. Check security vulnerabilities
check_security() {
  info "Checking for security vulnerabilities..."
  echo ""
  
  cd "$PROJECT_ROOT"
  
  info "Running npm audit..."
  pnpm audit --audit-level=moderate || true
  
  if command -v snyk &> /dev/null; then
    info "Running Snyk scan..."
    snyk test || true
  else
    warning "Snyk not installed. Install: npm install -g snyk"
  fi
  
  echo ""
}

# 6. Update agent prompts
update_agent_prompts() {
  info "Updating all agent prompts with communication protocol..."
  echo ""
  
  SNIPPET_FILE="$AUDIT_DIR/communication-protocol-snippet.md"
  
  if [ ! -f "$SNIPPET_FILE" ]; then
    warning "Creating communication protocol snippet..."
    cat > "$SNIPPET_FILE" << 'EOF'

## MANDATORY COMMUNICATION PROTOCOL (INÍCIO DE CADA TURNO)

1. INBOX CHECK (MANDATORY):
   sessions_inbox({ scope: "agent" })
   - Ler TODAS as mensagens pendentes
   - Identificar: instruções, bloqueios, perguntas, contexto
   - Responder perguntas diretas
   - Ajustar plano baseado em novo contexto

2. CONTEXT CHECK (MANDATORY):
   team_workspace({ action: "get_summary" })
   - Ler decisões recentes do time
   - Ler artefatos relevantes
   - Identificar dependências

3. BROADCAST (MANDATORY após cada entrega):
   - Postar NO CHAT PRINCIPAL o que foi feito
   - Usar @mentions para notificar dependentes
   - Salvar artefatos em team_workspace
   - Usar sessions_send para notificações diretas
EOF
    success "Snippet created at $SNIPPET_FILE"
  fi
  
  # Find agent files
  AGENT_FILES=$(find "$PROJECT_ROOT" -name "*.agent.yml" -o -name "*.agent.md" 2>/dev/null)
  
  if [ -z "$AGENT_FILES" ]; then
    warning "No agent files found. Are you in the right directory?"
    return
  fi
  
  UPDATED=0
  for agent in $AGENT_FILES; do
    if ! grep -q "INBOX CHECK" "$agent"; then
      info "Updating: $(basename $agent)"
      # Insert after "## Role Operating Profile" if exists
      if grep -q "## Role Operating Profile" "$agent"; then
        sed -i.bak "/## Role Operating Profile/r $SNIPPET_FILE" "$agent"
        rm "${agent}.bak"
        ((UPDATED++))
      else
        warning "No '## Role Operating Profile' found in $agent"
      fi
    fi
  done
  
  echo ""
  success "Updated $UPDATED agent files"
  warning "Review changes before committing!"
  echo ""
}

# 7. Setup coverage thresholds
setup_coverage() {
  info "Setting up coverage thresholds..."
  echo ""
  
  VITEST_CONFIG="$PROJECT_ROOT/vitest.config.ts"
  
  if [ ! -f "$VITEST_CONFIG" ]; then
    error "vitest.config.ts not found"
    return
  fi
  
  if grep -q "thresholds" "$VITEST_CONFIG"; then
    success "Coverage thresholds already configured"
  else
    warning "Manual update required. Add to vitest.config.ts:"
    echo ""
    cat << 'EOF'
coverage: {
  provider: 'v8',
  thresholds: {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
}
EOF
    echo ""
  fi
}

# 8. Setup security scanning
setup_security() {
  info "Setting up security scanning..."
  echo ""
  
  SECURITY_WORKFLOW="$PROJECT_ROOT/.github/workflows/security.yml"
  
  mkdir -p "$(dirname "$SECURITY_WORKFLOW")"
  
  if [ -f "$SECURITY_WORKFLOW" ]; then
    success "Security workflow already exists"
  else
    info "Creating security workflow..."
    cat > "$SECURITY_WORKFLOW" << 'EOF'
name: Security Scan

on: [pull_request, push]

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      
      - run: pnpm install
      - name: npm audit
        run: pnpm audit --audit-level=high
EOF
    success "Created $SECURITY_WORKFLOW"
  fi
  
  echo ""
}

# 9. Generate ADR template
generate_adr() {
  info "Generating ADR template..."
  echo ""
  
  ADR_DIR="$PROJECT_ROOT/docs/adr"
  mkdir -p "$ADR_DIR"
  
  # Get next ADR number
  LAST_ADR=$(ls "$ADR_DIR" | grep -E '^[0-9]+' | sort -n | tail -1 | cut -d- -f1 || echo "000")
  NEXT_NUM=$(printf "%03d" $((10#$LAST_ADR + 1)))
  
  echo -n "ADR title: "
  read -r TITLE
  
  FILENAME="$ADR_DIR/${NEXT_NUM}-${TITLE// /-}.md"
  
  cat > "$FILENAME" << EOF
# ADR ${NEXT_NUM}: ${TITLE}

**Status:** Proposed  
**Date:** $(date +%Y-%m-%d)  
**Deciders:** [Names]

---

## Context and Problem Statement

[Describe the context and problem]

## Decision Drivers

- [Driver 1]
- [Driver 2]

## Considered Options

### Option 1: [Title]

**Pros:**
- ✅ [Pro 1]

**Cons:**
- ❌ [Con 1]

### Option 2: [Title]

**Pros:**
- ✅ [Pro 1]

**Cons:**
- ❌ [Con 1]

## Decision Outcome

**Chosen option:** [Option X]

**Justification:** [Why]

### Consequences

**Positive:**
- ✅ [Consequence]

**Negative:**
- ❌ [Consequence]

## References

- [Link]
EOF
  
  success "Created $FILENAME"
  info "Edit and commit when ready"
  echo ""
}

# 10. Check progress
check_progress() {
  info "Checking implementation progress..."
  echo ""
  
  CHECKLIST="$AUDIT_DIR/CHECKLIST.md"
  
  if [ ! -f "$CHECKLIST" ]; then
    error "CHECKLIST.md not found"
    return
  fi
  
  TOTAL=$(grep -c "\- \[ \]" "$CHECKLIST" || echo 0)
  DONE=$(grep -c "\- \[x\]" "$CHECKLIST" || echo 0)
  
  if [ "$TOTAL" -eq 0 ]; then
    warning "No checklist items found"
    return
  fi
  
  PERCENT=$((100 * DONE / TOTAL))
  
  echo "Progress: $DONE/$TOTAL items completed ($PERCENT%)"
  echo ""
  
  if [ "$PERCENT" -eq 100 ]; then
    success "All tasks completed! 🎉"
  elif [ "$PERCENT" -ge 75 ]; then
    success "Almost there! $PERCENT% done"
  elif [ "$PERCENT" -ge 50 ]; then
    info "Good progress: $PERCENT% done"
  elif [ "$PERCENT" -ge 25 ]; then
    warning "Getting started: $PERCENT% done"
  else
    warning "Just beginning: $PERCENT% done"
  fi
  
  echo ""
}

# Validation functions
validate_phase1() {
  info "Validating Phase 1 completion..."
  echo ""
  
  PASSED=0
  FAILED=0
  
  # Check 1: Agents have protocol
  AGENTS_WITH_PROTOCOL=$(grep -r "INBOX CHECK" "$PROJECT_ROOT/agents" 2>/dev/null | wc -l || echo 0)
  if [ "$AGENTS_WITH_PROTOCOL" -eq 67 ]; then
    success "✅ All 67 agents have communication protocol"
    ((PASSED++))
  else
    error "❌ Only $AGENTS_WITH_PROTOCOL/67 agents have protocol"
    ((FAILED++))
  fi
  
  # Check 2: Auto-escalation
  if grep -q "escalation_sla_hours" "$PROJECT_ROOT/src/tools/delegation.ts" 2>/dev/null; then
    success "✅ Auto-escalation implemented"
    ((PASSED++))
  else
    error "❌ Auto-escalation not found"
    ((FAILED++))
  fi
  
  # Check 3: Coverage thresholds
  if grep -q "thresholds" "$PROJECT_ROOT/vitest.config.ts" 2>/dev/null; then
    success "✅ Coverage thresholds configured"
    ((PASSED++))
  else
    error "❌ Coverage thresholds not configured"
    ((FAILED++))
  fi
  
  # Check 4: Security scanning
  if [ -f "$PROJECT_ROOT/.github/workflows/security.yml" ]; then
    success "✅ Security scanning configured"
    ((PASSED++))
  else
    error "❌ Security scanning not configured"
    ((FAILED++))
  fi
  
  echo ""
  echo "Phase 1 validation: $PASSED passed, $FAILED failed"
  
  if [ "$FAILED" -eq 0 ]; then
    success "Phase 1 complete! Ready for Phase 2 🚀"
  else
    warning "Phase 1 incomplete. Fix failed checks before proceeding."
  fi
  
  echo ""
}

# Main loop
while true; do
  show_menu
  read -r option
  
  case $option in
    1) check_metrics ;;
    2) audit_coverage ;;
    3) audit_test_quality ;;
    4) find_missing_indexes ;;
    5) check_security ;;
    6) update_agent_prompts ;;
    7) setup_coverage ;;
    8) setup_security ;;
    9) generate_adr ;;
    10) check_progress ;;
    11) validate_phase1 ;;
    12) warning "Phase 2 validation not implemented yet" ;;
    13) warning "Phase 3 validation not implemented yet" ;;
    14) warning "Phase 4 validation not implemented yet" ;;
    0) 
      info "Goodbye!"
      exit 0
      ;;
    *)
      error "Invalid option"
      ;;
  esac
  
  echo ""
  echo -n "Press Enter to continue..."
  read -r
done

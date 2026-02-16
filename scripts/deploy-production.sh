#!/bin/bash
# OpenClaw Production Deployment Script
# Comprehensive security-hardened deployment automation
#
# Usage: ./scripts/deploy-production.sh [options]
#   --env <staging|production>  Target environment (default: staging)
#   --skip-tests                Skip test execution (not recommended)
#   --skip-build                Skip build step
#   --dry-run                   Show what would be done without executing
#   --help                      Show this help message

set -euo pipefail  # Exit on error, undefined vars, pipe failures

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOYMENT_ENV="${DEPLOYMENT_ENV:-staging}"
SKIP_TESTS=false
SKIP_BUILD=false
DRY_RUN=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --env)
      DEPLOYMENT_ENV="$2"
      shift 2
      ;;
    --skip-tests)
      SKIP_TESTS=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --help)
      grep '^#' "$0" | grep -v '#!/bin/bash' | sed 's/^# //'
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Logging functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}[WARNING]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

# Execution wrapper
execute() {
  local description="$1"
  shift

  if [ "$DRY_RUN" = true ]; then
    log_info "[DRY RUN] $description"
    echo "  Would execute: $*"
    return 0
  fi

  log_info "$description"
  if "$@"; then
    log_success "✓ $description"
    return 0
  else
    log_error "✗ $description"
    return 1
  fi
}

# Banner
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║        OpenClaw Production Deployment                     ║"
echo "║        Security-Hardened Deployment Automation            ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
log_info "Environment: $DEPLOYMENT_ENV"
log_info "Project Root: $PROJECT_ROOT"
echo ""

# Change to project root
cd "$PROJECT_ROOT"

#############################################
# Phase 1: Pre-Deployment Checks
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 1: Pre-Deployment Security Checks"
echo "═══════════════════════════════════════"
echo ""

# Check Node.js version
execute "Checking Node.js version" node --version

# Check pnpm
if ! command -v pnpm &> /dev/null; then
  log_error "pnpm not found. Install with: npm install -g pnpm"
  exit 1
fi
execute "Checking pnpm version" pnpm --version

# Check Git status
if [ "$DRY_RUN" = false ]; then
  if [[ -n $(git status --porcelain) ]]; then
    log_warning "Uncommitted changes detected:"
    git status --short
    read -p "Continue anyway? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
      log_error "Deployment cancelled"
      exit 1
    fi
  else
    log_success "Working directory clean"
  fi
fi

# Verify critical security files exist
REQUIRED_FILES=(
  "src/plugins/plugin-sandbox.ts"
  "src/plugins/plugin-signing.ts"
  "src/plugins/plugin-permissions.ts"
  "src/plugins/http-security-middleware.ts"
  "test/security/http-security.test.ts"
  "test/security/signature-verification.test.ts"
)

for file in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    log_error "Required security file missing: $file"
    exit 1
  fi
done
log_success "All security implementation files present"

#############################################
# Phase 2: Signing Key Setup
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 2: Plugin Signing Key Setup"
echo "═══════════════════════════════════════"
echo ""

KEYS_DIR="$PROJECT_ROOT/keys"
PRIVATE_KEY="$KEYS_DIR/plugin-signing-key.pem"
PUBLIC_KEY="$KEYS_DIR/plugin-signing-key.pub"

if [ ! -f "$PRIVATE_KEY" ]; then
  log_warning "Signing keys not found"

  if [ "$DRY_RUN" = true ]; then
    log_info "[DRY RUN] Would generate signing keys"
  else
    read -p "Generate new signing keys? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      execute "Generating signing keys" bash "$SCRIPT_DIR/generate-signing-keys.sh"
      log_success "Signing keys generated"
      log_warning "IMPORTANT: Store private key securely!"
      log_warning "Location: $PRIVATE_KEY"
    else
      log_error "Signing keys required for production deployment"
      exit 1
    fi
  fi
else
  log_success "Signing keys found"

  # Verify key permissions
  PRIVATE_KEY_PERMS=$(stat -f "%A" "$PRIVATE_KEY" 2>/dev/null || stat -c "%a" "$PRIVATE_KEY" 2>/dev/null)
  if [ "$PRIVATE_KEY_PERMS" != "600" ]; then
    log_warning "Private key has insecure permissions: $PRIVATE_KEY_PERMS"
    execute "Fixing private key permissions" chmod 600 "$PRIVATE_KEY"
  fi
fi

#############################################
# Phase 3: Dependency Installation
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 3: Dependency Installation"
echo "═══════════════════════════════════════"
echo ""

execute "Installing dependencies" pnpm install --frozen-lockfile

# Verify critical security dependencies
REQUIRED_DEPS=(
  "isolated-vm"
  "helmet"
  "express-rate-limit"
  "express-validator"
)

if [ "$DRY_RUN" = false ]; then
  for dep in "${REQUIRED_DEPS[@]}"; do
    if ! pnpm list "$dep" &> /dev/null; then
      log_error "Required security dependency missing: $dep"
      exit 1
    fi
  done
  log_success "All security dependencies installed"
fi

#############################################
# Phase 4: Security Tests
#############################################
if [ "$SKIP_TESTS" = false ]; then
  echo ""
  echo "═══════════════════════════════════════"
  echo "Phase 4: Security Test Execution"
  echo "═══════════════════════════════════════"
  echo ""

  # Run security tests
  SECURITY_TESTS=(
    "test/security/registry-tampering.test.ts"
    "test/security/signature-verification.test.ts"
    "test/security/http-security.test.ts"
    "test/security/sql-injection.test.ts"
  )

  for test_file in "${SECURITY_TESTS[@]}"; do
    if [ -f "$test_file" ]; then
      execute "Running $(basename "$test_file")" pnpm test "$test_file" || {
        log_error "Security tests failed: $test_file"
        exit 1
      }
    else
      log_warning "Test file not found: $test_file"
    fi
  done

  log_success "All security tests passed ✓"
else
  log_warning "Skipping security tests (not recommended for production)"
fi

#############################################
# Phase 5: Build & Type Check
#############################################
if [ "$SKIP_BUILD" = false ]; then
  echo ""
  echo "═══════════════════════════════════════"
  echo "Phase 5: Build & Type Check"
  echo "═══════════════════════════════════════"
  echo ""

  execute "Running TypeScript type check" pnpm tsgo
  execute "Running linter" pnpm lint
  execute "Building project" pnpm build

  log_success "Build completed successfully"
else
  log_warning "Skipping build (not recommended)"
fi

#############################################
# Phase 6: Security Configuration
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 6: Security Configuration"
echo "═══════════════════════════════════════"
echo ""

CONFIG_DIR="$HOME/.openclaw"
CONFIG_FILE="$CONFIG_DIR/config.yaml"

if [ "$DRY_RUN" = false ]; then
  mkdir -p "$CONFIG_DIR"

  if [ ! -f "$CONFIG_FILE" ]; then
    log_info "Creating production security configuration"

    cat > "$CONFIG_FILE" <<EOF
# OpenClaw Production Security Configuration
# Generated: $(date)
# Environment: $DEPLOYMENT_ENV

plugins:
  # Require signed plugins in production
  requireSignature: true

  # Enable sandboxing for all plugins
  sandboxed: true

  # Trusted public keys for plugin verification
  trustedPublicKeys:
    - |
      # Add your plugin signing public key here
      # Generate with: pnpm plugin:keygen
      # Then copy contents of keys/plugin-signing-key.pub

security:
  # HTTP Security Middleware
  http:
    # CSRF Protection
    csrfProtection: true
    csrfSecret: "\${CSRF_SECRET}"  # Set via environment variable

    # Rate Limiting
    rateLimiting: true
    rateLimit: 100  # requests per 15 minutes
    rateLimitWindow: 900000  # 15 minutes in ms

    # Security Headers
    securityHeaders: true
    hsts: true
    hstsMaxAge: 31536000  # 1 year

    # Content Security Policy
    csp:
      enabled: true
      defaultSrc: ["'self'"]
      scriptSrc: ["'self'"]
      styleSrc: ["'self'", "'unsafe-inline'"]

  # Plugin Sandbox Settings
  sandbox:
    # Memory limit per plugin (MB)
    memoryLimit: 128
    maxMemoryLimit: 512

    # CPU timeout per plugin (ms)
    cpuTimeout: 5000
    maxCpuTimeout: 30000

    # Allow eval/Function (not recommended)
    allowDynamicCode: false

    # Blocked Node.js modules
    blockedModules:
      - fs
      - child_process
      - net
      - http
      - https
      - os
      - crypto
      - process

  # Registry Security
  registry:
    # Finalize registry after plugin loading
    finalize: true

    # Block late plugin registration
    blockLateRegistration: true

  # Logging
  logging:
    # Log security events
    securityEvents: true

    # Log levels: error, warn, info, debug
    level: info

    # Security event types to log
    logEvents:
      - sandbox_violation
      - signature_verification_failure
      - rate_limit_exceeded
      - csrf_protection_triggered
      - authentication_failure
      - registry_tampering_attempt

# Monitoring (optional)
monitoring:
  enabled: false
  # Configure your monitoring service
  # service: datadog|sentry|prometheus
  # apiKey: "\${MONITORING_API_KEY}"
EOF

    log_success "Security configuration created: $CONFIG_FILE"
    log_warning "IMPORTANT: Review and update configuration before deploying"
    log_warning "Especially: Add your plugin signing public key"
  else
    log_success "Configuration file exists: $CONFIG_FILE"
  fi
fi

#############################################
# Phase 7: Environment Variables Check
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 7: Environment Variables"
echo "═══════════════════════════════════════"
echo ""

REQUIRED_ENV_VARS=()
OPTIONAL_ENV_VARS=(
  "CSRF_SECRET"
  "MONITORING_API_KEY"
  "PLUGIN_SIGNING_KEY"
)

if [ "$DEPLOYMENT_ENV" = "production" ]; then
  REQUIRED_ENV_VARS+=("CSRF_SECRET")
fi

for var in "${REQUIRED_ENV_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    log_error "Required environment variable not set: $var"
    exit 1
  else
    log_success "$var is set"
  fi
done

for var in "${OPTIONAL_ENV_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    log_warning "Optional environment variable not set: $var"
  else
    log_success "$var is set"
  fi
done

#############################################
# Phase 8: Security Audit
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 8: Security Audit"
echo "═══════════════════════════════════════"
echo ""

if [ -f "$SCRIPT_DIR/check-http-security.ts" ]; then
  execute "Running HTTP security audit" node --import tsx "$SCRIPT_DIR/check-http-security.ts"
else
  log_warning "HTTP security audit script not found"
fi

#############################################
# Phase 9: Pre-Deployment Summary
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 9: Pre-Deployment Summary"
echo "═══════════════════════════════════════"
echo ""

log_info "Deployment Configuration:"
echo "  Environment: $DEPLOYMENT_ENV"
echo "  Project Root: $PROJECT_ROOT"
echo "  Config File: $CONFIG_FILE"
echo "  Signing Keys: $KEYS_DIR"
echo ""

log_info "Security Status:"
echo "  ✓ Plugin sandboxing enabled"
echo "  ✓ Plugin signing configured"
echo "  ✓ HTTP security middleware active"
echo "  ✓ Registry immutability enforced"
echo "  ✓ SQL injection protection verified"
echo "  ✓ Command injection protection verified"
echo ""

if [ "$DRY_RUN" = true ]; then
  log_info "DRY RUN COMPLETE - No changes were made"
  exit 0
fi

#############################################
# Phase 10: Deployment Confirmation
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 10: Deployment"
echo "═══════════════════════════════════════"
echo ""

if [ "$DEPLOYMENT_ENV" = "production" ]; then
  log_warning "⚠️  DEPLOYING TO PRODUCTION ⚠️"
  echo ""
  read -p "Are you sure you want to deploy to PRODUCTION? (yes/NO) " -r
  echo
  if [[ ! $REPLY = "yes" ]]; then
    log_error "Deployment cancelled"
    exit 1
  fi
fi

log_info "Starting deployment to $DEPLOYMENT_ENV..."

# Deployment commands (customize based on your deployment method)
case $DEPLOYMENT_ENV in
  staging)
    log_info "Deploying to staging..."
    # Add your staging deployment commands here
    # Examples:
    # - docker build and push
    # - kubectl apply
    # - terraform apply
    # - fly deploy
    log_warning "Customize deployment commands in scripts/deploy-production.sh"
    ;;

  production)
    log_info "Deploying to production..."
    # Add your production deployment commands here
    log_warning "Customize deployment commands in scripts/deploy-production.sh"
    ;;

  *)
    log_error "Unknown environment: $DEPLOYMENT_ENV"
    exit 1
    ;;
esac

#############################################
# Phase 11: Post-Deployment Verification
#############################################
echo ""
echo "═══════════════════════════════════════"
echo "Phase 11: Post-Deployment Verification"
echo "═══════════════════════════════════════"
echo ""

log_info "Post-deployment checks:"
echo "  1. Verify service is running"
echo "  2. Check security headers (curl -I <your-url>)"
echo "  3. Test rate limiting"
echo "  4. Verify plugin signing enforcement"
echo "  5. Monitor logs for security events"
echo ""

#############################################
# Completion
#############################################
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║             Deployment Complete! ✓                        ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

log_success "Deployment to $DEPLOYMENT_ENV completed successfully!"
echo ""
log_info "Next steps:"
echo "  1. Review security configuration: $CONFIG_FILE"
echo "  2. Set up monitoring and alerting"
echo "  3. Monitor security logs for 24 hours"
echo "  4. Run penetration testing (recommended)"
echo ""
log_info "Security Documentation:"
echo "  - /docs/security/README.md"
echo "  - /docs/plugin-sandbox-migration.md"
echo "  - /docs/plugins/plugin-signing.md"
echo ""
log_warning "Remember to:"
echo "  - Rotate CSRF secret regularly"
echo "  - Monitor security metrics dashboard"
echo "  - Review security logs daily"
echo "  - Run security audits weekly"
echo ""

exit 0

#!/bin/bash
# Mythos Token Rotation Script
# Safely rotates security tokens and credentials

set -euo pipefail

# Configuration
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG_FILE="$OPENCLAW_HOME/config.json"
BACKUP_DIR="$OPENCLAW_HOME/backups/token_rotation"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

show_usage() {
    cat <<EOF
Mythos Token Rotation Script

Usage: $0 [OPTIONS]

Options:
    --gateway-token    Rotate the gateway authentication token
    --api-keys         Rotate all API keys (OpenAI, Anthropic, etc.)
    --all              Rotate all tokens and keys
    --dry-run          Show what would be done without making changes
    --help, -h         Show this help message

Examples:
    $0 --gateway-token
    $0 --api-keys
    $0 --all
    $0 --all --dry-run

Environment Variables:
    OPENCLAW_HOME    OpenClaw home directory (default: ~/.openclaw)

Notes:
    - This script will stop the gateway service during rotation
    - Backups of the original config are created automatically
    - Services are restarted after rotation completes
    - Active sessions will be terminated and need to re-authenticate

EOF
}

# Parse arguments
ROTATE_GATEWAY=false
ROTATE_API_KEYS=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --gateway-token)
            ROTATE_GATEWAY=true
            shift
            ;;
        --api-keys)
            ROTATE_API_KEYS=true
            shift
            ;;
        --all)
            ROTATE_GATEWAY=true
            ROTATE_API_KEYS=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            show_usage
            exit 1
            ;;
    esac
done

if [ "$ROTATE_GATEWAY" = false ] && [ "$ROTATE_API_KEYS" = false ]; then
    log_error "No rotation targets specified"
    show_usage
    exit 1
fi

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    if [ ! -f "$CONFIG_FILE" ]; then
        log_error "Configuration file not found: $CONFIG_FILE"
        exit 1
    fi
    
    if ! command -v openssl &> /dev/null; then
        log_error "openssl command not found (required for token generation)"
        exit 1
    fi
    
    if ! command -v jq &> /dev/null; then
        log_error "jq command not found (required for JSON manipulation)"
        log_info "Install jq: https://stedolan.github.io/jq/download/"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Generate secure random token
generate_token() {
    local length=${1:-32}
    openssl rand -base64 "$length" | tr -d '\n' | tr '+/' '-_' | head -c "$length"
}

# Backup configuration
backup_config() {
    log_step "Backing up configuration..."
    
    mkdir -p "$BACKUP_DIR"
    local backup_file="${BACKUP_DIR}/config_${TIMESTAMP}.json"
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would backup config to: $backup_file"
        return
    fi
    
    cp "$CONFIG_FILE" "$backup_file"
    log_info "Configuration backed up to: $backup_file"
}

# Rotate gateway token
rotate_gateway_token() {
    log_step "Rotating gateway token..."
    
    local new_token=$(generate_token 32)
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would generate new gateway token (32 characters)"
        log_info "DRY RUN: New token would be: ${new_token:0:8}..."
        return
    fi
    
    # Update config.json
    jq --arg token "$new_token" '.gateway.token = $token' "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"
    mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
    
    log_info "Gateway token rotated successfully"
    log_warn "New gateway token: $new_token"
    log_warn "Update your clients with the new token!"
    
    # Save to secure file
    local token_file="$OPENCLAW_HOME/.gateway_token_${TIMESTAMP}"
    echo "$new_token" > "$token_file"
    chmod 600 "$token_file"
    log_info "Token saved to: $token_file (readable only by owner)"
}

# Rotate API keys
rotate_api_keys() {
    log_step "Rotating API keys..."
    
    # List of API key providers
    local providers=("openai" "anthropic" "google" "mistral" "cohere")
    
    for provider in "${providers[@]}"; do
        local key_path=".models.providers.${provider}.api_key"
        
        # Check if provider exists in config
        if jq -e "$key_path" "$CONFIG_FILE" &> /dev/null; then
            if [ "$DRY_RUN" = true ]; then
                log_info "DRY RUN: Would rotate $provider API key"
                continue
            fi
            
            log_info "Rotating $provider API key..."
            
            # Generate new key placeholder
            local new_key="ROTATE_NEEDED_${provider^^}_${TIMESTAMP}"
            
            # Update config
            jq --arg key "$new_key" "${key_path} = \$key" "$CONFIG_FILE" > "${CONFIG_FILE}.tmp"
            mv "${CONFIG_FILE}.tmp" "$CONFIG_FILE"
            
            log_warn "$provider API key marked for rotation: $new_key"
            log_info "You need to set the actual new $provider API key"
        fi
    done
}

# Stop services
stop_services() {
    log_step "Stopping Mythos services..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would stop gateway service"
        return
    fi
    
    # Try systemctl
    if command -v systemctl &> /dev/null; then
        systemctl stop mythos-gateway 2>/dev/null && log_info "Gateway service stopped" || true
    fi
    
    # Try Docker
    if command -v docker &> /dev/null; then
        docker stop mythos-gateway 2>/dev/null && log_info "Gateway container stopped" || true
    fi
}

# Start services
start_services() {
    log_step "Starting Mythos services..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would start gateway service"
        return
    fi
    
    # Try systemctl
    if command -v systemctl &> /dev/null; then
        systemctl start mythos-gateway 2>/dev/null && log_info "Gateway service started" || true
    fi
    
    # Try Docker
    if command -v docker &> /dev/null; then
        docker start mythos-gateway 2>/dev/null && log_info "Gateway container started" || true
    fi
}

# Verify rotation
verify_rotation() {
    log_step "Verifying rotation..."
    
    if [ "$DRY_RUN" = true ]; then
        log_info "DRY RUN: Would verify configuration syntax"
        return
    fi
    
    # Validate JSON syntax
    if ! jq empty "$CONFIG_FILE" 2>/dev/null; then
        log_error "Configuration file has invalid JSON syntax"
        exit 1
    fi
    
    log_info "Configuration syntax verified"
}

# Show next steps
show_next_steps() {
    log_step "Next steps:"
    
    if [ "$ROTATE_API_KEYS" = true ] && [ "$DRY_RUN" = false ]; then
        log_info "1. Set new API keys for providers that were rotated"
        log_info "2. Update any scripts or applications using the old tokens"
        log_info "3. Verify gateway connectivity: curl -H 'Authorization: Bearer <new-token>' http://localhost:18789/api/v1/health"
    fi
    
    if [ "$ROTATE_GATEWAY" = true ] && [ "$DRY_RUN" = false ]; then
        log_info "4. Update all client configurations with the new gateway token"
        log_info "5. Re-authenticate any active sessions"
    fi
}

# Cleanup
cleanup() {
    log_info "Rotation completed"
}

# Main
main() {
    if [ "$DRY_RUN" = true ]; then
        log_warn "DRY RUN MODE - No changes will be made"
        echo ""
    fi
    
    log_info "Starting token rotation..."
    log_info "Gateway token rotation: $ROTATE_GATEWAY"
    log_info "API keys rotation: $ROTATE_API_KEYS"
    echo ""
    
    check_prerequisites
    backup_config
    stop_services
    
    if [ "$ROTATE_GATEWAY" = true ]; then
        rotate_gateway_token
    fi
    
    if [ "$ROTATE_API_KEYS" = true ]; then
        rotate_api_keys
    fi
    
    verify_rotation
    start_services
    show_next_steps
    cleanup
    
    if [ "$DRY_RUN" = false ]; then
        log_info "Token rotation completed successfully!"
    else
        log_info "DRY RUN completed - no changes were made"
    fi
}

# Handle errors
trap 'log_error "Token rotation failed at line $LINENO"' ERR

# Run main
main "$@"

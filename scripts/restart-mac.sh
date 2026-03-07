#!/bin/bash
# restart-mac.sh - Build and restart the macOS menubar app
# Supports universal binary builds for both Intel (x86_64) and Apple Silicon (arm64)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Build architecture configuration
# Set BUILD_ARCHS=all to build universal binary for both x86_64 and arm64
# Default is to build for current architecture only
BUILD_ARCHS="${BUILD_ARCHS:-current}"

# Function to build for a specific architecture
build_for_arch() {
    local arch=$1
    local build_dir="${PROJECT_ROOT}/.build/${arch}"

    log_info "Building for architecture: ${arch}"

    mkdir -p "${build_dir}"

    # Build with swift
    swift build         --package-path "${PROJECT_ROOT}"         --build-path "${build_dir}"         --configuration release         --arch "${arch}"

    echo "${build_dir}/release/openclaw-menubar"
}

# Function to create universal binary
create_universal_binary() {
    local arm64_binary=$1
    local x86_64_binary=$2
    local output_path=$3

    log_info "Creating universal binary..."

    # Check if both binaries exist
    if [[ ! -f "${arm64_binary}" ]]; then
        log_error "arm64 binary not found: ${arm64_binary}"
        return 1
    fi

    if [[ ! -f "${x86_64_binary}" ]]; then
        log_error "x86_64 binary not found: ${x86_64_binary}"
        return 1
    fi

    # Create universal binary using lipo
    mkdir -p "$(dirname "${output_path}")"
    lipo -create         "${arm64_binary}"         "${x86_64_binary}"         -output "${output_path}"

    # Verify universal binary
    local archs
    archs=$(lipo -archs "${output_path}")
    log_info "Universal binary created with architectures: ${archs}"

    echo "${output_path}"
}

# Main build function
build_macos_app() {
    log_info "Building macOS menubar app..."
    log_info "Build architectures: ${BUILD_ARCHS}"

    local output_binary

    if [[ "${BUILD_ARCHS}" == "all" ]]; then
        # Build universal binary
        log_info "Building universal binary for Intel and Apple Silicon..."

        local arm64_binary
        local x86_64_binary

        arm64_binary=$(build_for_arch "arm64")
        x86_64_binary=$(build_for_arch "x86_64")

        output_binary="${PROJECT_ROOT}/.build/universal/release/openclaw-menubar"
        create_universal_binary "${arm64_binary}" "${x86_64_binary}" "${output_binary}"
    else
        # Build for current architecture only
        local current_arch
        current_arch=$(uname -m)
        log_info "Building for current architecture: ${current_arch}"
        output_binary=$(build_for_arch "${current_arch}")
    fi

    echo "${output_binary}"
}

# Function to restart the app
restart_app() {
    local binary_path=$1

    log_info "Restarting OpenClaw menubar app..."

    # Kill existing process if running
    if pgrep -f "openclaw-menubar" > /dev/null; then
        log_info "Stopping existing process..."
        pkill -f "openclaw-menubar" || true
        sleep 1
    fi

    # Start new instance
    log_info "Starting new instance..."
    "${binary_path}" &

    log_info "OpenClaw menubar app started successfully!"
}

# Function to package the app
package_app() {
    local binary_path=$1
    local package_dir="${PROJECT_ROOT}/.build/package"

    log_info "Packaging app..."

    # Create package directory
    mkdir -p "${package_dir}"

    # Copy binary
    cp "${binary_path}" "${package_dir}/openclaw-menubar"

    # Copy resources if they exist
    if [[ -d "${PROJECT_ROOT}/assets" ]]; then
        cp -r "${PROJECT_ROOT}/assets" "${package_dir}/"
    fi

    # Create Info.plist
    cat > "${package_dir}/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>openclaw-menubar</string>
    <key>CFBundleIdentifier</key>
    <string>ai.openclaw.menubar</string>
    <key>CFBundleName</key>
    <string>OpenClaw</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
EOF

    log_info "App packaged at: ${package_dir}"
    echo "${package_dir}"
}

# Main execution
main() {
    log_info "OpenClaw macOS Menubar Build Script"
    log_info "===================================="

    # Parse arguments
    local should_restart=false
    local should_package=false

    while [[ $# -gt 0 ]]; do
        case $1 in
            --restart)
                should_restart=true
                shift
                ;;
            --package)
                should_package=true
                shift
                ;;
            --help)
                echo "Usage: $0 [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --restart    Restart the app after building"
                echo "  --package    Package the app for distribution"
                echo "  --help       Show this help message"
                echo ""
                echo "Environment Variables:"
                echo "  BUILD_ARCHS  Set to 'all' to build universal binary (default: current)"
                echo ""
                echo "Examples:"
                echo "  $0                              # Build for current architecture"
                echo "  BUILD_ARCHS=all $0              # Build universal binary"
                echo "  $0 --restart                    # Build and restart"
                echo "  $0 --package                    # Build and package"
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    # Build the app
    local binary_path
    binary_path=$(build_macos_app)

    # Package if requested
    if [[ "${should_package}" == true ]]; then
        package_app "${binary_path}"
    fi

    # Restart if requested
    if [[ "${should_restart}" == true ]]; then
        restart_app "${binary_path}"
    fi

    log_info "Build completed successfully!"
    log_info "Binary location: ${binary_path}"
}

# Run main function
main "$@"

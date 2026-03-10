#!/bin/bash
# Build sherpa-onnx native library for Android
# This script downloads and compiles sherpa-onnx for all supported Android architectures

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ANDROID_APP_DIR="$PROJECT_ROOT/apps/android"
LIBS_DIR="$ANDROID_APP_DIR/app/libs"
JNI_DIR="$ANDROID_APP_DIR/app/src/main/jniLibs"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SHERPA_VERSION="v1.10.4"
SHERPA_DIR="$PROJECT_ROOT/../sherpa-onnx"
BUILD_DIR="$ANDROID_APP_DIR/build-sherpa-onnx"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check dependencies
check_dependencies() {
    log_info "Checking dependencies..."

    if ! command -v git &> /dev/null; then
        log_error "git is required but not installed"
        exit 1
    fi

    if ! command -v cmake &> /dev/null; then
        log_error "cmake is required but not installed"
        exit 1
    fi

    if ! command -v ninja &> /dev/null; then
        log_warn "ninja not found, will use make"
    fi

    # Check for Android NDK
    if [ -z "$ANDROID_NDK_HOME" ]; then
        if [ -n "$ANDROID_HOME" ]; then
            export ANDROID_NDK_HOME="$ANDROID_HOME/ndk-bundle"
        fi
    fi

    if [ ! -d "$ANDROID_NDK_HOME" ]; then
        log_error "Android NDK not found. Please set ANDROID_NDK_HOME or ANDROID_HOME"
        exit 1
    fi

    log_info "Android NDK found at: $ANDROID_NDK_HOME"
}

# Clone or update sherpa-onnx
setup_sherpa_onnx() {
    log_info "Setting up sherpa-onnx..."

    if [ -d "$SHERPA_DIR/.git" ]; then
        log_info "Updating existing sherpa-onnx repository..."
        cd "$SHERPA_DIR"
        git fetch origin
        git checkout "$SHERPA_VERSION"
        git pull origin "$SHERPA_VERSION"
    else
        log_info "Cloning sherpa-onnx repository..."
        git clone https://github.com/k2-fsa/sherpa-onnx.git "$SHERPA_DIR"
        cd "$SHERPA_DIR"
        git checkout "$SHERPA_VERSION"
    fi

    log_info "sherpa-onnx $SHERPA_VERSION ready"
}

# Build for a specific architecture
build_arch() {
    local arch=$1
    local abi=$2
    local cmake_toolchain=$3

    log_info "Building for $arch ($abi)..."

    local build_arch_dir="$BUILD_DIR/build-$arch"
    mkdir -p "$build_arch_dir"

    cd "$build_arch_dir"

    cmake \
        -DCMAKE_TOOLCHAIN_FILE="$cmake_toolchain" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DSHERPA_ONNX_ENABLE_PYTHON=OFF \
        -DSHERPA_ONNX_ENABLE_TESTS=OFF \
        -DSHERPA_ONNX_ENABLE_PORTAUDIO=OFF \
        -DSHERPA_ONNX_ENABLE_JNI=ON \
        -DANDROID_ABI=$abi \
        -DANDROID_PLATFORM=android-31 \
        -DCMAKE_ANDROID_ARCH_ABI=$abi \
        -DCMAKE_SYSTEM_NAME=Android \
        -DCMAKE_ANDROID_NDK="$ANDROID_NDK_HOME" \
        "$SHERPA_DIR"

    cmake --build "$build_arch_dir" -j$(nproc)

    # Copy the built library
    local lib_dir="$JNI_DIR/$abi"
    mkdir -p "$lib_dir"

    if [ -f "$build_arch_dir/libsherpa-onnx-jni.so" ]; then
        cp "$build_arch_dir/libsherpa-onnx-jni.so" "$lib_dir/"
        log_info "Copied libsherpa-onnx-jni.so to $lib_dir"
    else
        log_warn "Library not found for $arch, searching..."
        find "$build_arch_dir" -name "*.so" -type f | head -5
    fi
}

# Build all architectures
build_all() {
    log_info "Building sherpa-onnx for all architectures..."

    mkdir -p "$BUILD_DIR"
    mkdir -p "$JNI_DIR"

    local toolchain="$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake"

    # Build for each architecture
    build_arch "arm64" "arm64-v8a" "$toolchain"
    build_arch "armv7" "armeabi-v7a" "$toolchain"
    build_arch "x86_64" "x86_64" "$toolchain"
    build_arch "x86" "x86" "$toolchain"

    log_info "Build complete!"
}

# Create AAR package
create_aar() {
    log_info "Creating AAR package..."

    local aar_dir="$BUILD_DIR/aar"
    mkdir -p "$aar_dir"

    # Create AAR structure
    mkdir -p "$aar_dir/jni"
    mkdir -p "$aar_dir/META-INF"

    # Copy native libraries
    for abi in arm64-v8a armeabi-v7a x86 x86_64; do
        if [ -d "$JNI_DIR/$abi" ]; then
            cp -r "$JNI_DIR/$abi" "$aar_dir/jni/"
        fi
    done

    # Create manifest
    cat > "$aar_dir/AndroidManifest.xml" <<EOF
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.k2fsa.sherpa.onnx">
</manifest>
EOF

    # Create jar for JNI classes
    mkdir -p "$aar_dir/classes"
    # Note: JNI classes should be compiled separately

    # Create AAR
    cd "$aar_dir"
    zip -r "$LIBS_DIR/sherpa-onnx-android-${SHERPA_VERSION}.aar" . > /dev/null

    log_info "AAR created: $LIBS_DIR/sherpa-onnx-android-${SHERPA_VERSION}.aar"
}

# Download pre-built binaries (alternative to building)
download_prebuilt() {
    log_info "Downloading pre-built sherpa-onnx binaries..."

    local prebuilt_url="https://github.com/k2fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/sherpa-onnx-android-${SHERPA_VERSION}.aar"

    mkdir -p "$LIBS_DIR"

    if command -v wget &> /dev/null; then
        wget -O "$LIBS_DIR/sherpa-onnx-android-${SHERPA_VERSION}.aar" "$prebuilt_url"
    elif command -v curl &> /dev/null; then
        curl -L -o "$LIBS_DIR/sherpa-onnx-android-${SHERPA_VERSION}.aar" "$prebuilt_url"
    else
        log_error "Neither wget nor curl is available"
        exit 1
    fi

    log_info "Downloaded: $LIBS_DIR/sherpa-onnx-android-${SHERPA_VERSION}.aar"

    # Extract native libraries from AAR
    cd "$LIBS_DIR"
    unzip -q "sherpa-onnx-android-${SHERPA_VERSION}.aar" -d sherpa-onnx-extract

    if [ -d "sherpa-onnx-extract/jni" ]; then
        cp -r sherpa-onnx-extract/jni/* "$JNI_DIR/"
        log_info "Native libraries extracted to $JNI_DIR"
    fi

    # Clean up
    rm -rf sherpa-onnx-extract
}

# Main execution
main() {
    log_info "sherpa-onnx Android build script"
    log_info "================================"

    check_dependencies

    case "${1:-build}" in
        download)
            download_prebuilt
            ;;
        build)
            setup_sherpa_onnx
            build_all
            create_aar
            ;;
        setup)
            setup_sherpa_onnx
            ;;
        aar)
            create_aar
            ;;
        clean)
            log_info "Cleaning build directories..."
            rm -rf "$BUILD_DIR"
            rm -rf "$JNI_DIR"
            log_info "Clean complete"
            ;;
        *)
            echo "Usage: $0 {download|build|setup|aar|clean}"
            echo ""
            echo "Commands:"
            echo "  download  - Download pre-built binaries from GitHub releases"
            echo "  build     - Build from source for all architectures"
            echo "  setup     - Clone/update sherpa-onnx repository"
            echo "  aar       - Create AAR package from existing builds"
            echo "  clean     - Remove build artifacts"
            exit 1
            ;;
    esac

    log_info "Done!"
}

main "$@"

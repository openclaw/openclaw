#!/bin/bash
# Build checksum-pinned OpenClawAudioAECNative prerequisites. No upstream patches.
# Requires Xcode command-line tools, Python 3.12+, CMake, Ninja, and pkg-config.
# All downloads, build products, licenses, and provenance stay in ignored .build/aec.
set -euo pipefail
trap 'status=$?; if [[ $status -ne 0 ]]; then echo "[build-mac-aec] FAILED (exit $status)" >&2; fi' EXIT

if [[ "$(uname -s)" != Darwin ]]; then
  echo "Usage: scripts/build-mac-aec.sh [arm64] [x86_64] (macOS only)" >&2
  exit 2
fi
for tool in python3 cmake ninja pkg-config xcrun; do
  command -v "$tool" >/dev/null || { echo "Missing build prerequisite: $tool" >&2; exit 1; }
done
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
aec_root="$repo_root/apps/macos/.build/aec"
mkdir -p "$aec_root"
# Keep one writer per dependency prefix, independently of SwiftPM's build lock.
mkdir "$aec_root/build.lock" || { echo "AEC build already running; inspect $aec_root/build.lock" >&2; exit 1; }
trap 'status=$?; rmdir "$aec_root/build.lock"; if [[ $status -ne 0 ]]; then echo "[build-mac-aec] FAILED (exit $status)" >&2; fi' EXIT

python3 - "$aec_root" "$repo_root/scripts/build-mac-aec.sh" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

if sys.version_info < (3, 12):
    raise SystemExit("Python 3.12+ is required for safe archive extraction")
architectures = sys.argv[3:] or [os.uname().machine]
if len(set(architectures)) != len(architectures) or any(a not in ("arm64", "x86_64") for a in architectures):
    raise SystemExit("Expected unique architectures: arm64 and/or x86_64")
root = Path(sys.argv[1])
downloads = root / "downloads"
downloads.mkdir(exist_ok=True)
prefix = root / "install"
sources = [
    ("webrtc-audio-processing-2.1.tar.xz",
     "https://gstreamer.freedesktop.org/src/mirror/webrtc-audio-processing/webrtc-audio-processing-2.1.tar.xz",
     "ae9302824b2038d394f10213cab05312c564a038434269f11dbf68f511f9f9fe"),
    # APM accepts >=20240722; .1 fixes the hash-container issue in the bundled .0 wrap.
    ("abseil-cpp-20240722.1.tar.gz",
     "https://github.com/abseil/abseil-cpp/releases/download/20240722.1/abseil-cpp-20240722.1.tar.gz",
     "40cee67604060a7c8794d931538cb55f4d444073e556980c88b6c49bb9b19bb7"),
    ("meson-1.12.0-py3-none-any.whl",
     "https://files.pythonhosted.org/packages/07/68/b0117422eb0a46d9d8d9e328f0c5b5c835179bfc058688bca35c90c89eba/meson-1.12.0-py3-none-any.whl",
     "71f133147fa0fcfe8f4df49fa1045771064947834538409e5d97b3613aac8b4e"),
]

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)

def output(*args):
    return subprocess.check_output(args, text=True).strip()

for filename, url, expected in sources:
    archive = downloads / filename
    if not archive.exists():
        print("Downloading", filename, flush=True)
        temporary = archive.with_suffix(archive.suffix + ".partial")
        with urllib.request.urlopen(url, timeout=60) as response, temporary.open("wb") as target:
            shutil.copyfileobj(response, target)
        if digest(temporary) != expected:
            raise SystemExit("Download SHA256 mismatch: " + filename)
        temporary.replace(archive)
    if digest(archive) != expected:
        raise SystemExit("Cached archive SHA256 mismatch: " + filename)
    if filename.endswith(".whl"):
        continue
    with tarfile.open(archive) as contents:
        members = contents.getmembers()
        source_root = root / members[0].name.split("/")[0]
        if not source_root.exists():
            contents.extractall(root, filter="data")
        # Reuse builds only when every upstream source file remains byte-identical.
        for member in members:
            if member.isfile():
                path = root / member.name
                if not path.is_file() or path.read_bytes() != contents.extractfile(member).read():
                    raise SystemExit("Upstream source changed; remove the task-owned .build/aec tree and retry")

tools = root / "tools"
if not (tools / "bin/python").exists():
    run(sys.executable, "-m", "venv", tools)
run(tools / "bin/python", "-m", "pip", "install", "--disable-pip-version-check",
    "--no-index", "--no-deps", downloads / sources[2][0])
meson = tools / "bin/meson"
clang = output("xcrun", "--find", "clang")
clangxx = output("xcrun", "--find", "clang++")
sdk = output("xcrun", "--sdk", "macosx", "--show-sdk-path")
jobs = str(min(8, os.cpu_count() or 1))
smoke = root / "apm-smoke.cc"
smoke.write_text(r'''
#include "api/audio/audio_processing.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <random>
#include <vector>
int main() {
    auto apm = webrtc::AudioProcessingBuilder().Create();
    webrtc::AudioProcessing::Config config;
    config.echo_canceller.enabled = true;
    apm->ApplyConfig(config);
    constexpr int samples = 480, blocks = 2000, delay = 3840;
    webrtc::StreamConfig format(48000, 1);
    std::mt19937 generator(42);
    std::uniform_real_distribution<float> noise(-0.25f, 0.25f);
    std::vector<float> reference(samples * blocks);
    for (auto& value : reference) value = noise(generator);
    std::array<float, samples> render{}, capture{}, clean{};
    double before = 0, after = 0;
    for (int block = 0; block < blocks; ++block) {
        for (int i = 0; i < samples; ++i) {
            const int index = block * samples + i;
            render[i] = reference[index];
            capture[i] = index >= delay ? 0.65f * reference[index - delay] : 0;
        }
        const float* reverse[] = {render.data()};
        float* reverseOutput[] = {render.data()};
        const float* input[] = {capture.data()};
        float* result[] = {clean.data()};
        if (apm->ProcessReverseStream(reverse, format, format, reverseOutput) != 0 ||
            apm->set_stream_delay_ms(80) != 0 || apm->ProcessStream(input, format, format, result) != 0) return 2;
        if (block >= 1500) for (int i = 0; i < samples; ++i) {
            before += capture[i] * capture[i];
            after += clean[i] * clean[i];
        }
    }
    std::printf("Synthetic AEC smoke: attenuation_db=%.2f (no microphone or speaker access)\n",
                10 * std::log10(before / (after + 1e-20)));
    return before > 0 && after < before * 0.01 ? 0 : 3;
}
''')
architecture_proof = []
libraries = []
for arch in architectures:
    arch_root = root / arch
    arch_root.mkdir(exist_ok=True)
    prefix = arch_root / "install"
    environment = dict(os.environ, CC=clang, CXX=clangxx, SDKROOT=sdk, CFLAGS="", CXXFLAGS="", LDFLAGS="",
                       PKG_CONFIG_PATH="", PKG_CONFIG_LIBDIR=str(prefix / "lib/pkgconfig"))
    abseil = root / "abseil-cpp-20240722.1"
    run("cmake", "-S", abseil, "-B", arch_root / "abseil-build", "-G", "Ninja",
        "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_SHARED_LIBS=OFF", "-DABSL_BUILD_TESTING=OFF",
        "-DABSL_ENABLE_INSTALL=ON", "-DABSL_PROPAGATE_CXX_STD=ON", "-DCMAKE_CXX_STANDARD=17",
        "-DCMAKE_OSX_ARCHITECTURES=" + arch, "-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0",
        "-DCMAKE_OSX_SYSROOT=" + sdk, "-DCMAKE_CXX_COMPILER=" + clangxx,
        "-DCMAKE_INSTALL_LIBDIR=lib", "-DCMAKE_INSTALL_PREFIX=" + str(prefix), env=environment)
    run("cmake", "--build", arch_root / "abseil-build", "--parallel", jobs, env=environment)
    run("cmake", "--install", arch_root / "abseil-build", env=environment)
    # Abseil's generated pkg-config flags leave paths unquoted. Quote the installed
    # metadata so Meson preserves spaces in checkout paths; upstream sources stay intact.
    for metadata in (prefix / "lib/pkgconfig").glob("absl_*.pc"):
        contents = metadata.read_text()
        metadata.write_text(contents.replace('-I${includedir}', '-I"${includedir}"')
                           .replace('-L${libdir}', '-L"${libdir}"'))
    machine = arch_root / "cross.ini"
    compile_arguments = ["-arch", arch, "-mmacosx-version-min=15.0", "-isysroot", sdk]
    link_arguments = compile_arguments + ["-framework", "CoreFoundation", "-framework", "Foundation"]
    # APM selects SIMD source files from host_machine, not clang's -arch flag alone.
    machine.write_text(
        "[binaries]\nc = " + repr(clang) + "\ncpp = " + repr(clangxx) +
        "\npkg-config = " + repr(shutil.which("pkg-config")) +
        "\n[host_machine]\nsystem = 'darwin'\ncpu_family = " +
        repr("aarch64" if arch == "arm64" else arch) + "\ncpu = " + repr(arch) +
        "\nendian = 'little'\n[properties]\nneeds_exe_wrapper = true\n" +
        "pkg_config_libdir = " + repr(str(prefix / "lib/pkgconfig")) + "\n")
    apm = root / "webrtc-audio-processing-2.1"
    build = arch_root / "apm-build"
    reconfigure = ["--reconfigure", "--clearcache"] if (build / "meson-private/coredata.dat").exists() else []
    # nofallback prevents Meson from selecting its older bundled Abseil wrap or host libraries.
    run(meson, "setup", *reconfigure, build, apm, "--cross-file", machine,
        "--prefix", prefix, "--libdir", "lib", "--buildtype", "release",
        "--default-library", "static", "--wrap-mode", "nofallback",
        "-Dc_args=" + repr(compile_arguments), "-Dcpp_args=" + repr(compile_arguments),
        "-Dcpp_link_args=" + repr(link_arguments), env=environment)
    run(meson, "compile", "-C", build, "-j", jobs, env=environment)
    run(meson, "install", "-C", build, "--no-rebuild", env=environment)

    # Static Meson install omits transitive archives. Merge their unchanged objects once;
    # SwiftPM then links a single relocatable archive without runtime dylib search paths.
    archives = sorted((build / "webrtc").rglob("*.a")) + sorted((prefix / "lib").glob("libabsl_*.a"))
    if not archives:
        raise SystemExit("Native dependency archives missing")
    library = prefix / "lib/libOpenClawWebRTCAEC.a"
    run("/usr/bin/libtool", "-static", "-o", library, *archives)
    if output("/usr/bin/lipo", "-archs", str(library)) != arch:
        raise SystemExit("Unexpected AEC library architecture")

    run(clangxx, "-std=c++17", "-arch", arch, "-mmacosx-version-min=15.0", "-isysroot", sdk,
        "-DWEBRTC_MAC", "-DWEBRTC_POSIX", "-DWEBRTC_LIBRARY_IMPL",
        "-I", prefix / "include/webrtc-audio-processing-2", "-I", prefix / "include",
        smoke, library, "-framework", "Foundation", "-framework", "CoreFoundation", "-o", arch_root / "apm-smoke")
    if output("/usr/bin/lipo", "-archs", str(arch_root / "apm-smoke")) != arch:
        raise SystemExit("Unexpected AEC smoke executable architecture")
    smoke_result = (output(str(arch_root / "apm-smoke")) if arch == os.uname().machine
                    else "Cross-compiled and linked; execution requires a matching Mac")
    print(arch + ": " + smoke_result, flush=True)
    architecture_proof.append({"architecture": arch, "archive_sha256": digest(library),
        "input_archives": [str(p.relative_to(root)) for p in archives], "validation": smoke_result})
    libraries.append(library)

# All slices share installed public headers; only the static objects differ.
prefix = root / "install"
header_source = libraries[0].parent.parent / "include"
expected_headers = {str(p.relative_to(header_source)): digest(p) for p in header_source.rglob("*") if p.is_file()}
for archive in libraries[1:]:
    headers = archive.parent.parent / "include"
    if {str(p.relative_to(headers)): digest(p) for p in headers.rglob("*") if p.is_file()} != expected_headers:
        raise SystemExit("Architecture-dependent public headers cannot share one SwiftPM prefix")
shutil.copytree(header_source, prefix / "include", dirs_exist_ok=True)
(prefix / "lib/pkgconfig").mkdir(parents=True, exist_ok=True)
library = prefix / "lib/libOpenClawWebRTCAEC.a"
temporary = library.with_suffix(".partial.a")
run("/usr/bin/lipo", "-create", *libraries, "-output", temporary)
if set(output("/usr/bin/lipo", "-archs", str(temporary)).split()) != set(architectures):
    raise SystemExit("Unexpected combined AEC library architectures")
temporary.replace(library)
apm = root / "webrtc-audio-processing-2.1"
abseil = root / "abseil-cpp-20240722.1"

licenses = root / "licenses"
license_paths = ["COPYING", "webrtc/LICENSE", "webrtc/PATENTS",
    "webrtc/common_audio/third_party/ooura/LICENSE",
    "webrtc/common_audio/third_party/spl_sqrt_floor/LICENSE",
    "webrtc/modules/third_party/fft/LICENSE", "webrtc/third_party/pffft/LICENSE",
    "webrtc/third_party/rnnoise/COPYING"]
for relative in license_paths:
    target = licenses / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(apm / relative, target)
(licenses / "abseil").mkdir(exist_ok=True)
shutil.copyfile(abseil / "LICENSE", licenses / "abseil/LICENSE")
pc = prefix / "lib/pkgconfig/openclaw-aec.pc"
pc.write_text(f"prefix={prefix}\nName: OpenClaw AEC\nDescription: Static WebRTC APM + Abseil\n"
              'Version: 2.1\nLibs: -L"${prefix}/lib" -lOpenClawWebRTCAEC -lc++ '
              "-framework Foundation -framework CoreFoundation\n"
              'Cflags: -I"${prefix}/include/webrtc-audio-processing-2" -I"${prefix}/include" '
              "-DWEBRTC_MAC -DWEBRTC_POSIX -DWEBRTC_LIBRARY_IMPL\n")
provenance = {
    "sources": [{"url": url, "sha256": sha} for _, url, sha in sources],
    "apm_release_commit": "846fe90a289f58b7c9303a635142aa2c7caa93e5",
    "abseil_version": "20240722.1", "architectures": architecture_proof, "minimum_macos": "15.0",
    "source_patches": [], "installed_metadata_adjustments": ["Quote Abseil pkg-config include/library paths"],
    "script_sha256": digest(Path(sys.argv[2])),
    "compiler": output(clangxx, "--version"), "sdk": output("xcrun", "--sdk", "macosx", "--show-sdk-version"),
    "cmake": output("cmake", "--version").splitlines()[0], "meson": output(str(meson), "--version"),
    "ninja": output("ninja", "--version"), "pkg_config": output("pkg-config", "--version"),
    "archive_sha256": digest(library),
    "licenses": sorted(str(p.relative_to(licenses)) for p in licenses.rglob("*") if p.is_file()),
}
(root / "provenance.json").write_text(json.dumps(provenance, indent=2, sort_keys=True) + "\n")
print("Built unmodified APM 2.1 with Abseil 20240722.1:", library)
print("Architectures:", ", ".join(architectures))
PY

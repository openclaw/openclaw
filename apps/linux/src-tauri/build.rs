fn main() {
    link_macos_swift_runtime();
    prepare_runtime_manifest();
    // Cargo builds do not require Node; this is the same literal include used by
    // scripts/lib/standalone-installers.mjs, with no candidate code execution.
    let installer = include_str!("../../../scripts/install-cli.sh").replace(
        r#"source "${BASH_SOURCE[0]%${BASH_SOURCE[0]##*/}}./install-policy.sh""#,
        include_str!("../../../scripts/install-policy.sh").trim_end(),
    );
    std::fs::create_dir_all("target/installers").expect("installer output directory");
    std::fs::write("target/installers/install-cli.sh", installer).expect("standalone installer");
    const COMMANDS: &[&str] = &[
        "bootstrap",
        "build_info",
        "check_for_updates",
        "close_connection_settings",
        "connect_discovered_gateway",
        "connect_remote_gateway",
        "discover_gateways",
        "gateway_request",
        "gateway_profile_request",
        "gateway_action",
        "install_cli",
        "native_browser_request",
        "native_device_settings_request",
        "open_release_page",
        "relaunch",
        "updater_ready",
        "window_chrome_drag",
        "window_chrome_request",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Tauri build configuration should be valid");
}

fn prepare_runtime_manifest() {
    // The Tauri hooks fetch verified resources. Plain Cargo tests stay offline and
    // compile a sentinel that makes local installation fail with an actionable error.
    let directory = std::path::Path::new("target/desktop-runtime");
    std::fs::create_dir_all(directory).expect("runtime resource directory");
    let manifest = directory.join("manifest.json");
    if !manifest.exists() {
        std::fs::write(&manifest, "{}\n").expect("unstaged runtime sentinel");
    }
    println!("cargo:rerun-if-changed={}", manifest.display());
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output"));
    if !matches!(
        std::env::var("CARGO_CFG_TARGET_OS").as_deref(),
        Ok("linux" | "windows")
    ) {
        std::fs::write(output.join("desktop-runtime.json"), "{}\n")
            .expect("unbundled runtime sentinel");
        return;
    }
    std::fs::copy(manifest, output.join("desktop-runtime.json")).expect("compile runtime identity");
}

/// tauri-plugin-notifications links a Swift static library into us, but nothing
/// adds an rpath for the Swift runtime it pulls in. Bundled apps get one from
/// the bundler; plain `cargo run` and `cargo test` binaries do not, so they die
/// at load with `Library not loaded: @rpath/libswift_Concurrency.dylib`. Point
/// them at the OS runtime so the test suite is runnable on macOS.
fn link_macos_swift_runtime() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
}

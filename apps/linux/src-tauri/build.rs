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
    std::fs::write(
        "target/installers/install.ps1",
        include_bytes!("../../../scripts/install.ps1"),
    )
    .expect("canonical Windows installer");
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
    // The Tauri hooks stage verified resources. Plain Cargo tests stay offline and
    // compile a sentinel that makes local installation fail with an actionable error.
    let directory = std::path::Path::new("target/desktop-runtime");
    std::fs::create_dir_all(directory).expect("runtime resource directory");
    let manifest = directory.join("manifest.json");
    if !manifest.exists() {
        std::fs::write(&manifest, "{}\n").expect("unstaged runtime sentinel");
    }
    println!("cargo:rerun-if-changed={}", manifest.display());
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo output"));
    let platform = std::env::var("CARGO_CFG_TARGET_OS").expect("Cargo target OS");
    if !matches!(platform.as_str(), "linux" | "windows") {
        std::fs::write(output.join("desktop-runtime.json"), "{}\n")
            .expect("unsupported runtime sentinel");
        return;
    }
    let bytes = std::fs::read(&manifest).expect("staged runtime manifest");
    if platform == "windows" {
        let runtime: serde_json::Value =
            serde_json::from_slice(&bytes).expect("valid staged runtime manifest");
        if !runtime.as_object().is_some_and(|value| value.is_empty()) {
            let test_only = runtime
                .get("testOnly")
                .map(|value| value.as_bool().expect("boolean runtime testOnly flag"))
                .unwrap_or(false);
            let signed = runtime
                .get("authenticodeSigned")
                .and_then(|value| value.as_bool());
            if test_only {
                assert_eq!(
                    signed,
                    Some(false),
                    "Unsigned proof must be marked unsigned"
                );
                assert_eq!(
                    std::env::var("PROFILE").as_deref(),
                    Ok("debug"),
                    "Unsigned Windows runtime proof is restricted to debug builds"
                );
            } else {
                assert_eq!(
                    signed,
                    Some(true),
                    "Windows runtime requires an Authenticode-signed artifact"
                );
            }
        }
    }
    std::fs::write(output.join("desktop-runtime.json"), bytes).expect("compile runtime identity");
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

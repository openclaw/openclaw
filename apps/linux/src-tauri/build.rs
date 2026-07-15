fn main() {
    const COMMANDS: &[&str] = &[
        "bootstrap",
        "canvas_a2ui_action",
        "gateway_action",
        "install_cli",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("Tauri build configuration should be valid");
}

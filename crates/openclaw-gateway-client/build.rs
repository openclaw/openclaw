use std::{env, fs, path::PathBuf};

fn main() {
    let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/gateway-protocol/src/version.ts");
    println!("cargo:rerun-if-changed={}", source_path.display());
    let source = fs::read_to_string(source_path).expect("canonical Gateway protocol versions");
    let mut generated =
        String::from("// Generated from packages/gateway-protocol/src/version.ts.\n");
    for name in [
        "PROTOCOL_VERSION",
        "MIN_CLIENT_PROTOCOL_VERSION",
        "MIN_NODE_PROTOCOL_VERSION",
        "MIN_PROBE_PROTOCOL_VERSION",
    ] {
        let prefix = format!("export const {name} = ");
        let value: u32 = source
            .lines()
            .find_map(|line| line.strip_prefix(&prefix))
            .and_then(|value| value.strip_suffix(" as const;"))
            .unwrap_or_else(|| panic!("missing canonical protocol constant {name}"))
            .parse()
            .unwrap_or_else(|_| panic!("invalid canonical protocol constant {name}"));
        generated.push_str(&format!("pub const {name}: u32 = {value};\n"));
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    fs::write(output.join("protocol_versions.rs"), generated).expect("Rust protocol versions");
}

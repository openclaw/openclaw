use std::{env, fs, path::PathBuf};

fn main() {
    let icons = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../../ui/public/provider-icons");
    println!("cargo:rerun-if-changed={}", icons.display());
    let mut paths: Vec<_> = fs::read_dir(&icons)
        .expect("read shared Control UI provider icons")
        .map(|entry| entry.expect("provider icon entry").path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "svg"))
        .collect();
    paths.sort();
    let mut source = String::from("pub const PROVIDER_ICONS: &[(&str, &[u8])] = &[\n");
    for path in paths {
        let name = path.file_name().unwrap().to_str().unwrap();
        source.push_str(&format!(
            "({:?}, include_bytes!({:?})),\n",
            format!("provider-icons/{name}"),
            path
        ));
    }
    source.push_str("];");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("provider_icons.rs"),
        source,
    )
    .expect("embed shared provider icons");
}

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    embed_build_info(&root);
    let icons = root.join("../../ui/public/provider-icons");
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

fn embed_build_info(root: &Path) {
    let mut watched = vec!["HEAD".to_owned(), "packed-refs".to_owned()];
    if let Some(reference) = git_output(root, &["symbolic-ref", "--quiet", "HEAD"]) {
        watched.push(reference);
    }
    for reference in watched {
        if let Some(path) = git_output(root, &["rev-parse", "--git-path", &reference]) {
            let path = root.join(path);
            // A packed branch may gain a loose ref; watch its parent until it exists.
            if let Some(path) = path.ancestors().find(|path| path.exists()) {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
    let info = git_output(root, &["show", "--no-patch", "--format=%H%n%ct", "HEAD"]);
    let mut lines = info.as_deref().unwrap_or_default().lines();
    let commit = lines.next().unwrap_or_default();
    let commit = commit.get(..7).unwrap_or_default();
    let timestamp = lines.next().unwrap_or_default();
    println!("cargo:rustc-env=GPUI_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=GPUI_BUILD_COMMIT_TIME={timestamp}");
}

fn git_output(root: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

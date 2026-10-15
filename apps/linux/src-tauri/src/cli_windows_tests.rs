use super::{managed_launcher, OpenClawCli};
use crate::runtime_action::{bind_runtime, install_launcher, BundledRuntime, Purpose};
use std::ffi::OsStr;
use std::fs;
use std::path::PathBuf;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "openclaw runtime & 100% ! {}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(path.join("package")).unwrap();
        let fixture = Self(fs::canonicalize(path).unwrap());
        fs::write(fixture.0.join("bun.exe"), "synthetic Bun").unwrap();
        fs::write(fixture.0.join("package/entry.js"), "synthetic entry").unwrap();
        fixture
    }

    fn runtime(&self) -> BundledRuntime {
        BundledRuntime {
            bun: self.0.join("bun.exe"),
            sqlite: None,
        }
    }

    fn entry(&self) -> PathBuf {
        self.0.join("package").join("entry.js")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn windows_managed_launcher_invokes_bun_directly_with_literal_arguments() {
    let fixture = Fixture::new();
    install_launcher(
        &fixture.0,
        &fixture.runtime(),
        &fixture.entry(),
        Purpose::Gateway,
    )
    .unwrap();
    // Locate the same managed install without executing the synthetic runtime.
    let cli = OpenClawCli::new(managed_launcher(&fixture.0), fixture.0.clone());
    let payload = "literal & echo unwanted | %PATH% !delayed! \"quoted\"";
    let command = cli.command(["gateway", "status", payload]).unwrap();
    assert_eq!(command.get_program(), fixture.runtime().bun.as_os_str());
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        vec![
            OsStr::new("--no-install"),
            fixture.entry().as_os_str(),
            OsStr::new("gateway"),
            OsStr::new("status"),
            OsStr::new(payload),
        ]
    );
    assert!(command
        .get_envs()
        .any(|(key, value)| key == "OPENCLAW_SQLITE_LIBRARY" && value.is_none()));
    bind_runtime(&cli, &fixture.runtime(), Purpose::Browser).unwrap();
    assert!(cli.command(["--version"]).is_ok());

    let launcher = crate::cli::managed_launcher(&fixture.0);
    fs::write(&launcher, "@echo independent operator command\r\n").unwrap();
    assert!(cli.command(["--version"]).is_err());
    assert!(install_launcher(
        &fixture.0,
        &fixture.runtime(),
        &fixture.entry(),
        Purpose::Gateway,
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(launcher).unwrap(),
        "@echo independent operator command\r\n"
    );
}

#[test]
fn windows_launcher_rejects_an_entry_outside_the_managed_prefix() {
    let fixture = Fixture::new();
    let other = Fixture::new();
    assert!(install_launcher(
        &fixture.0,
        &fixture.runtime(),
        &other.entry(),
        Purpose::Gateway,
    )
    .is_err());
    assert!(!crate::cli::managed_launcher(&fixture.0).exists());
}

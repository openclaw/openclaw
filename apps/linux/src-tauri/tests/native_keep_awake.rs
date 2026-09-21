#![cfg(any(target_os = "macos", target_os = "windows"))]

#[path = "../src/keep_awake.rs"]
mod keep_awake;
#[path = "../src/keep_awake_platform.rs"]
mod keep_awake_platform;

use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::Duration;

// Observe the real platform guard after its own Drop, not a substitute release.
struct ObservedGuard {
    guard: Option<keep_awake_platform::Inhibitor>,
    released: Arc<AtomicUsize>,
}

impl keep_awake::Inhibitor for ObservedGuard {
    fn release(&mut self) -> Result<(), String> {
        keep_awake::Inhibitor::release(self.guard.as_mut().unwrap())?;
        verify_native_request(false);
        Ok(())
    }
}

impl Drop for ObservedGuard {
    fn drop(&mut self) {
        drop(self.guard.take());
        verify_native_request(false);
        self.released.fetch_add(1, Ordering::SeqCst);
    }
}

#[cfg(target_os = "macos")]
fn verify_native_request(expected: bool) {
    let result = std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "assertions"])
        .output()
        .expect("read macOS power assertions");
    assert!(result.status.success());
    let output = String::from_utf8(result.stdout).unwrap();
    let owner = format!("pid {}(", std::process::id());
    let owned: Vec<_> = output
        .lines()
        .filter(|line| {
            line.trim_start().starts_with(&owner) && line.contains("OpenClaw: Keep computer awake")
        })
        .collect();
    assert_eq!(
        owned
            .iter()
            .any(|line| line.contains("PreventUserIdleSystemSleep")),
        expected,
        "this test process must own exactly its requested system-idle assertion"
    );
    assert!(
        !owned
            .iter()
            .any(|line| line.contains("PreventUserIdleDisplaySleep")),
        "keeping the system awake must not keep the display awake"
    );
}

#[cfg(target_os = "windows")]
fn verify_native_request(expected: bool) {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetThreadExecutionState(flags: u32) -> u32;
    }
    const CONTINUOUS: u32 = 0x8000_0000;
    const SYSTEM_REQUIRED: u32 = 1;
    const DISPLAY_REQUIRED: u32 = 2;
    // This returns the prior state on the same worker thread. Reasserting the
    // expected state cannot hide a missing acquisition or failed release:
    // either defect is visible in the returned prior SYSTEM_REQUIRED bit.
    let previous =
        unsafe { SetThreadExecutionState(CONTINUOUS | if expected { SYSTEM_REQUIRED } else { 0 }) };
    assert_ne!(previous, 0, "Windows execution-state query failed");
    assert_eq!(previous & SYSTEM_REQUIRED != 0, expected);
    assert_eq!(previous & DISPLAY_REQUIRED, 0);
}

fn start(
    saved: &Arc<AtomicBool>,
    released: &Arc<AtomicUsize>,
) -> (keep_awake::KeepAwake, mpsc::Receiver<keep_awake::Status>) {
    let read = Arc::clone(saved);
    let write = Arc::clone(saved);
    let released = Arc::clone(released);
    let (send, receive) = mpsc::channel();
    let owner = keep_awake::KeepAwake::start(
        move || Ok(read.load(Ordering::SeqCst)),
        move |enabled| {
            write.store(enabled, Ordering::SeqCst);
            Ok(())
        },
        move || {
            let guard = keep_awake_platform::Inhibitor::acquire()?;
            verify_native_request(true);
            Ok(ObservedGuard {
                guard: Some(guard),
                released: Arc::clone(&released),
            })
        },
        move |status| {
            verify_native_request(status.active);
            send.send(status).unwrap();
        },
    )
    .unwrap();
    (owner, receive)
}

fn expect_status(reports: &mpsc::Receiver<keep_awake::Status>, enabled: bool) {
    let status = reports.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(status.error.is_none(), "{status:?}");
    assert_eq!((status.enabled, status.active), (enabled, enabled));
}

#[test]
fn native_power_lifecycle_acquires_restores_and_releases_on_disable_and_quit() {
    let saved = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicUsize::new(0));
    let (owner, reports) = start(&saved, &released);
    expect_status(&reports, false);
    owner.toggle().unwrap();
    expect_status(&reports, true);
    assert!(saved.load(Ordering::SeqCst));
    owner.wait_stopped();
    assert_eq!(
        released.load(Ordering::SeqCst),
        1,
        "quit must drop the native guard on its owner thread"
    );
    let (owner, reports) = start(&saved, &released);
    expect_status(&reports, true);
    owner.toggle().unwrap();
    expect_status(&reports, false);
    assert!(!saved.load(Ordering::SeqCst));
    owner.wait_stopped();
    assert_eq!(released.load(Ordering::SeqCst), 2);
    println!("{} native power API verified: enable, quit release, worker restart restoration, disable release", std::env::consts::OS);
}

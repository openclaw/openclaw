use crate::keep_awake::{Inhibitor, KeepAwake, Status};
use std::{
    marker::PhantomData,
    rc::Rc,
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

#[derive(Default)]
struct Fixture {
    saved: bool,
    read_error: bool,
    write_error: bool,
    acquire_error: bool,
    release_error: bool,
    acquired: usize,
    released: usize,
    threads: Vec<thread::ThreadId>,
}
struct Guard {
    fixture: Arc<Mutex<Fixture>>,
    active: bool,
    _thread: PhantomData<Rc<()>>,
}
impl Inhibitor for Guard {
    fn release(&mut self) -> Result<(), String> {
        let mut f = self.fixture.lock().unwrap();
        if f.release_error {
            return Err("release failed".into());
        }
        if self.active {
            self.active = false;
            f.released += 1;
            f.threads.push(thread::current().id());
        }
        Ok(())
    }
}
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
fn start(f: &Arc<Mutex<Fixture>>) -> (KeepAwake, mpsc::Receiver<Status>) {
    let read = Arc::clone(f);
    let write = Arc::clone(f);
    let acquire = Arc::clone(f);
    let (sender, receiver) = mpsc::channel();
    let owner = KeepAwake::start(
        move || {
            let f = read.lock().unwrap();
            if f.read_error {
                Err("read failed".into())
            } else {
                Ok(f.saved)
            }
        },
        move |enabled| {
            let mut f = write.lock().unwrap();
            if f.write_error {
                return Err("write failed".into());
            }
            f.saved = enabled;
            Ok(())
        },
        move || {
            let mut f = acquire.lock().unwrap();
            if f.acquire_error {
                return Err("acquire failed".into());
            }
            f.acquired += 1;
            f.threads.push(thread::current().id());
            Ok(Guard {
                fixture: Arc::clone(&acquire),
                active: true,
                _thread: PhantomData,
            })
        },
        move |status| {
            sender.send(status).unwrap();
        },
    )
    .unwrap();
    (owner, receiver)
}
fn status(receiver: &mpsc::Receiver<Status>, active: bool, error: Option<(&str, &str)>) {
    let status = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(status.active, active);
    match error {
        Some((title, message)) => {
            let error = status.error.unwrap();
            assert_eq!(error.title(), title);
            assert!(error.message().contains(message));
        }
        None => assert!(status.error.is_none()),
    }
}
#[test]
fn default_off_toggle_restart_and_shutdown_own_one_native_request() {
    let f = Arc::new(Mutex::new(Fixture::default()));
    let (owner, reports) = start(&f);
    status(&reports, false, None);
    assert_eq!(f.lock().unwrap().acquired, 0);
    owner.toggle().unwrap();
    status(&reports, true, None);
    assert!(f.lock().unwrap().saved);
    owner.wait_stopped();
    assert!(owner.toggle().is_err());
    {
        let f = f.lock().unwrap();
        assert_eq!((f.acquired, f.released), (1, 1));
        assert_eq!(f.threads[0], f.threads[1]);
    }
    let (owner, reports) = start(&f);
    status(&reports, true, None);
    owner.toggle().unwrap();
    status(&reports, false, None);
    assert!(!f.lock().unwrap().saved);
    owner.wait_stopped();
    assert_eq!(f.lock().unwrap().released, 2);
    let (owner, reports) = start(&f);
    status(&reports, false, None);
    drop(owner);
    assert_eq!(f.lock().unwrap().acquired, 2);
}
#[test]
fn enable_failure_never_saves_or_leaks_a_native_request() {
    for fail_acquire in [true, false] {
        let f = Arc::new(Mutex::new(Fixture {
            acquire_error: fail_acquire,
            write_error: !fail_acquire,
            ..Fixture::default()
        }));
        let (owner, reports) = start(&f);
        status(&reports, false, None);
        owner.toggle().unwrap();
        status(
            &reports,
            false,
            Some(if fail_acquire {
                ("Keep computer awake", "acquire failed")
            } else {
                ("Saved Gateways", "write failed")
            }),
        );
        owner.wait_stopped();
        let f = f.lock().unwrap();
        assert!(!f.saved);
        assert_eq!(f.acquired, f.released);
    }
}
#[test]
fn failed_release_stays_active_but_failed_save_reports_restart_risk() {
    let f = Arc::new(Mutex::new(Fixture {
        saved: true,
        release_error: true,
        ..Fixture::default()
    }));
    let (owner, reports) = start(&f);
    status(&reports, true, None);
    owner.toggle().unwrap();
    status(
        &reports,
        true,
        Some(("Keep computer awake", "release failed")),
    );
    {
        let mut f = f.lock().unwrap();
        assert!(f.saved);
        assert_eq!(f.released, 0);
        f.release_error = false;
        f.write_error = true;
    }
    owner.toggle().unwrap();
    status(
        &reports,
        false,
        Some(("Saved Gateways", "may turn on again after restarting")),
    );
    assert!(f.lock().unwrap().saved);
    f.lock().unwrap().write_error = false;
    owner.toggle().unwrap();
    status(&reports, false, None);
    assert!(!f.lock().unwrap().saved);
    owner.wait_stopped();
    assert_eq!(f.lock().unwrap().acquired, 1);
    assert_eq!(f.lock().unwrap().released, 1);
}
#[test]
fn failed_restoration_can_be_disabled_without_retrying_the_unavailable_platform() {
    let f = Arc::new(Mutex::new(Fixture {
        saved: true,
        acquire_error: true,
        ..Fixture::default()
    }));
    let (owner, reports) = start(&f);
    status(
        &reports,
        false,
        Some(("Keep computer awake", "acquire failed")),
    );
    owner.toggle().unwrap();
    status(&reports, false, None);
    assert!(!f.lock().unwrap().saved);
    assert_eq!(f.lock().unwrap().acquired, 0);
    owner.wait_stopped();
}
#[test]
fn unavailable_shared_preferences_leave_power_off_without_a_duplicate_startup_alert() {
    let f = Arc::new(Mutex::new(Fixture {
        saved: true,
        read_error: true,
        ..Fixture::default()
    }));
    let (owner, reports) = start(&f);
    let initial = reports.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(!initial.enabled);
    assert!(!initial.active);
    assert!(initial.error.is_none(), "{initial:?}");
    {
        let mut f = f.lock().unwrap();
        assert!(f.saved);
        assert_eq!((f.acquired, f.released), (0, 0));
        f.write_error = true;
    }
    // A user-initiated retry names the shared store and releases the new
    // request if persistence is still unavailable.
    owner.toggle().unwrap();
    status(&reports, false, Some(("Saved Gateways", "write failed")));
    {
        let mut f = f.lock().unwrap();
        assert!(f.saved);
        assert_eq!((f.acquired, f.released), (1, 1));
        f.read_error = false;
        f.write_error = false;
    }
    owner.toggle().unwrap();
    status(&reports, true, None);
    owner.wait_stopped();
    let f = f.lock().unwrap();
    assert!(f.saved);
    assert_eq!((f.acquired, f.released), (2, 2));
}
#[test]
fn shutdown_during_acquisition_releases_without_persisting_or_publishing() {
    let f = Arc::new(Mutex::new(Fixture::default()));
    let acquire = Arc::clone(&f);
    let write = Arc::clone(&f);
    let (entered, entry) = mpsc::channel();
    let (resume, resumed) = mpsc::channel();
    let (report, reports) = mpsc::channel();
    let owner = KeepAwake::start(
        || Ok(false),
        move |enabled| {
            write.lock().unwrap().saved = enabled;
            Ok(())
        },
        move || {
            entered.send(()).unwrap();
            resumed.recv().unwrap();
            acquire.lock().unwrap().acquired += 1;
            Ok(Guard {
                fixture: Arc::clone(&acquire),
                active: true,
                _thread: PhantomData,
            })
        },
        move |status| {
            report.send(status).unwrap();
        },
    )
    .unwrap();
    status(&reports, false, None);
    owner.toggle().unwrap();
    entry.recv_timeout(Duration::from_secs(5)).unwrap();
    owner.stop();
    resume.send(()).unwrap();
    owner.wait_stopped();
    assert!(reports.try_recv().is_err());
    let f = f.lock().unwrap();
    assert!(!f.saved);
    assert_eq!((f.acquired, f.released), (1, 1));
}

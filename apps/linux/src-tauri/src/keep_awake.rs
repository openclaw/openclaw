//! One worker owns the native request and serializes preference changes.
//! Windows execution-state requests must be created and cleared on this thread.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread::{self, JoinHandle};

pub trait Inhibitor {
    fn release(&mut self) -> Result<(), String>;
}

#[derive(Debug)]
pub struct Status {
    pub enabled: bool,
    pub active: bool,
    pub error: Option<String>,
}

pub struct KeepAwake {
    sender: Mutex<Option<mpsc::Sender<()>>>,
    stopping: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl KeepAwake {
    pub fn start<G: Inhibitor + 'static>(
        read: impl Fn() -> Result<bool, String> + Send + 'static,
        write: impl Fn(bool) -> Result<(), String> + Send + 'static,
        acquire: impl Fn() -> Result<G, String> + Send + 'static,
        publish: impl Fn(Status) + Send + 'static,
    ) -> Result<Self, String> {
        let (sender, receiver) = mpsc::channel();
        let stopping = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&stopping);
        let worker = thread::Builder::new().name("keep-awake".into()).spawn(move || {
            let mut inhibitor = None;
            let mut enabled = false;
            let restored = read().and_then(|saved| {
                enabled = saved;
                if enabled && !stop.load(Ordering::SeqCst) {
                    inhibitor = Some(acquire()?);
                }
                Ok(())
            });
            if !stop.load(Ordering::SeqCst) {
                publish(Status { enabled, active: inhibitor.is_some(), error: restored.err() });
            }
            for () in receiver {
                if stop.load(Ordering::SeqCst) { break; }
                // Saved intent survives failed restoration. Toggle that intent,
                // not the presence of a guard, so the user can still turn it off.
                let result = if enabled {
                    let released = inhibitor.as_mut().map_or(Ok(()), Inhibitor::release);
                    released.and_then(|()| {
                        inhibitor = None;
                        write(false).map_err(|error| format!(
                            "Idle sleep is allowed now, but the preference could not be saved. It may turn on again after restarting OpenClaw. {error}"
                        ))?;
                        enabled = false;
                        Ok(())
                    })
                } else {
                    acquire().and_then(|guard| {
                        if stop.load(Ordering::SeqCst) { return Ok(()); }
                        // Persist only after acquiring the OS request. A failed
                        // write drops the new guard and leaves the setting off.
                        write(true)?;
                        enabled = true;
                        inhibitor = Some(guard);
                        Ok(())
                    })
                };
                if !stop.load(Ordering::SeqCst) {
                    publish(Status { enabled, active: inhibitor.is_some(), error: result.err() });
                }
            }
            // Explicit drop before join returns also releases thread-affine guards.
            drop(inhibitor);
        }).map_err(|error| format!("Could not start idle-sleep control: {error}"))?;
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            stopping,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn toggle(&self) -> Result<(), String> {
        let sender = self
            .sender
            .lock()
            .map_err(|_| "Idle-sleep control is unavailable.")?;
        if self.stopping.load(Ordering::SeqCst) {
            return Err("OpenClaw is quitting.".into());
        }
        sender
            .as_ref()
            .ok_or("Idle-sleep control has stopped.")?
            .send(())
            .map_err(|_| "Idle-sleep control has stopped. Restart OpenClaw and try again.".into())
    }

    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        self.sender
            .lock()
            .expect("keep-awake sender poisoned")
            .take();
    }

    pub fn wait_stopped(&self) {
        self.stop();
        if let Some(worker) = self
            .worker
            .lock()
            .expect("keep-awake worker poisoned")
            .take()
        {
            if worker.join().is_err() {
                eprintln!("Idle-sleep control stopped unexpectedly.");
            }
        }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        self.wait_stopped();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{marker::PhantomData, rc::Rc, time::Duration};

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
    fn status(receiver: &mpsc::Receiver<Status>, active: bool, error: Option<&str>) {
        let status = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(status.active, active);
        match error {
            Some(error) => assert!(status.error.unwrap().contains(error)),
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
                    "acquire failed"
                } else {
                    "write failed"
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
        status(&reports, true, Some("release failed"));
        {
            let mut f = f.lock().unwrap();
            assert!(f.saved);
            assert_eq!(f.released, 0);
            f.release_error = false;
            f.write_error = true;
        }
        owner.toggle().unwrap();
        status(&reports, false, Some("may turn on again after restarting"));
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
        status(&reports, false, Some("acquire failed"));
        owner.toggle().unwrap();
        status(&reports, false, None);
        assert!(!f.lock().unwrap().saved);
        assert_eq!(f.lock().unwrap().acquired, 0);
        owner.wait_stopped();
    }
    #[test]
    fn startup_error_is_visible_without_changing_the_saved_preference() {
        for fail_read in [true, false] {
            let f = Arc::new(Mutex::new(Fixture {
                saved: true,
                read_error: fail_read,
                acquire_error: !fail_read,
                ..Fixture::default()
            }));
            let (owner, reports) = start(&f);
            status(
                &reports,
                false,
                Some(if fail_read {
                    "read failed"
                } else {
                    "acquire failed"
                }),
            );
            owner.wait_stopped();
            assert!(f.lock().unwrap().saved);
            assert_eq!(f.lock().unwrap().acquired, 0);
        }
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
}

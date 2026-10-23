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
            let mut result = read().and_then(|saved| {
                enabled = saved;
                if enabled && !stop.load(Ordering::SeqCst) {
                    inhibitor = Some(acquire()?);
                }
                Ok(())
            });
            loop {
                if !stop.load(Ordering::SeqCst) {
                    publish(Status { enabled, active: inhibitor.is_some(), error: result.err() });
                }
                if receiver.recv().is_err() || stop.load(Ordering::SeqCst) { break; }
                // Saved intent survives failed restoration. Toggle that intent,
                // not the presence of a guard, so the user can still turn it off.
                result = if enabled {
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

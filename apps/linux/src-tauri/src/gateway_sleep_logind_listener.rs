use crate::gateway_sleep::GatewaySleepCycleController;
use futures_util::StreamExt;
use std::sync::Arc;
use zbus::zvariant::OwnedFd;

// Returns whether a cycle actually began (a remote/unconfigured route must not
// activate the driver); the paired end hook runs only for cycles that began.
pub(crate) type BeginSleepCycleHook = Arc<dyn Fn() -> bool + Send + Sync>;
pub(crate) type EndSleepCycleHook = Arc<dyn Fn() + Send + Sync>;

struct SleepCycleGuard {
    abandon: Option<(Arc<GatewaySleepCycleController>, u64)>,
    end: EndSleepCycleHook,
}

impl Drop for SleepCycleGuard {
    fn drop(&mut self) {
        if let Some((controller, generation)) = &self.abandon {
            controller.abandon(*generation);
        }
        (self.end)();
    }
}

#[zbus::proxy(
    default_service = "org.freedesktop.login1",
    default_path = "/org/freedesktop/login1",
    interface = "org.freedesktop.login1.Manager"
)]
trait Login1Manager {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> zbus::Result<OwnedFd>;

    #[zbus(signal)]
    fn prepare_for_sleep(&self, sleeping: bool) -> zbus::Result<()>;
}

pub(crate) async fn run_listener(
    controller: Arc<GatewaySleepCycleController>,
    begin_sleep_cycle: BeginSleepCycleHook,
    end_sleep_cycle: EndSleepCycleHook,
) -> Result<(), String> {
    let connection = zbus::Connection::system()
        .await
        .map_err(|error| format!("could not connect to the system bus: {error}"))?;
    run_listener_on_connection(&connection, controller, begin_sleep_cycle, end_sleep_cycle).await
}

async fn run_listener_on_connection(
    connection: &zbus::Connection,
    controller: Arc<GatewaySleepCycleController>,
    begin_sleep_cycle: BeginSleepCycleHook,
    end_sleep_cycle: EndSleepCycleHook,
) -> Result<(), String> {
    let proxy = Login1ManagerProxy::new(connection)
        .await
        .map_err(|error| format!("could not connect to systemd-logind: {error}"))?;
    let mut signals = proxy
        .receive_prepare_for_sleep()
        .await
        .map_err(|error| format!("could not subscribe to PrepareForSleep: {error}"))?;
    let mut inhibitor = Some(acquire_inhibitor(&proxy).await?);
    let mut cycle = None;

    while let Some(signal) = signals.next().await {
        let sleeping = signal
            .args()
            .map_err(|error| format!("invalid PrepareForSleep signal: {error}"))?
            .sleeping;
        if sleeping {
            if cycle.is_none() && begin_sleep_cycle() {
                cycle = Some(SleepCycleGuard {
                    abandon: None,
                    end: Arc::clone(&end_sleep_cycle),
                });
            }
            let (generation, preparation) = controller.will_sleep();
            if let Some(cycle) = cycle.as_mut() {
                cycle.abandon = generation.map(|generation| (Arc::clone(&controller), generation));
            }
            preparation.await;
            // Releasing the delay inhibitor lets logind continue into sleep.
            inhibitor.take();
        } else {
            let cycle = cycle.take().map(|mut cycle| {
                // Real wake transfers recovery authority before the task can poll.
                // Later listener loss must not abandon this already-observed wake.
                cycle.abandon = None;
                cycle
            });
            let recovery = controller.did_wake();
            // Spawn wake recovery before touching logind again: a slow or hung
            // Inhibit call must not delay reconnect/resume. Spawning also keeps
            // the signal loop consuming so a new sleep cycle can abort retries.
            tauri::async_runtime::spawn(async move {
                // Keep this cycle's depth until recovery ends, including cancellation.
                let _cycle = cycle;
                recovery.await;
            });
            // A failed re-acquire only loses the pre-sleep delay window; keep the
            // listener alive so later sleep/wake cycles are still handled.
            inhibitor = match acquire_inhibitor(&proxy).await {
                Ok(fd) => Some(fd),
                Err(error) => {
                    eprintln!("Gateway sleep: {error}");
                    None
                }
            };
        }
    }
    Err("PrepareForSleep signal stream ended".into())
}

async fn acquire_inhibitor(proxy: &Login1ManagerProxy<'_>) -> Result<OwnedFd, String> {
    proxy
        .inhibit("sleep", "OpenClaw", "Suspending local gateway", "delay")
        .await
        .map_err(|error| format!("could not acquire the logind sleep inhibitor: {error}"))
}

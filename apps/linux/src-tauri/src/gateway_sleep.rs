use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const RESUME_ATTEMPTS: usize = 3;
const RESUME_RETRY_DELAY: Duration = Duration::from_secs(2);

type PrepareFuture = Pin<Box<dyn Future<Output = Result<SleepPrepareOutcome, String>> + Send>>;
type ResumeFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;
type RefreshFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type DelayFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum SleepPrepareOutcome {
    Ready { suspension_id: String },
    Busy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GatewaySleepRoute {
    pub(crate) ws_url: String,
    pub(crate) generation: u64,
}

struct HeldSuspension {
    id: String,
    route: GatewaySleepRoute,
}

#[derive(Clone)]
pub(crate) struct GatewaySleepCycleController {
    request_id: String,
    current_route: Arc<dyn Fn() -> Option<GatewaySleepRoute> + Send + Sync>,
    prepare: Arc<dyn Fn(String, GatewaySleepRoute) -> PrepareFuture + Send + Sync>,
    resume: Arc<dyn Fn(String, GatewaySleepRoute) -> ResumeFuture + Send + Sync>,
    refresh: Arc<dyn Fn() -> RefreshFuture + Send + Sync>,
    retry_delay: Arc<dyn Fn(Duration) -> DelayFuture + Send + Sync>,
    log: Arc<dyn Fn(String) + Send + Sync>,
    suspension: Arc<Mutex<Option<HeldSuspension>>>,
}

impl GatewaySleepCycleController {
    pub(crate) fn new<P, PF, R, RF, F, FF, C, D, DF, L>(
        request_id: String,
        current_route: C,
        prepare: P,
        resume: R,
        refresh: F,
        retry_delay: D,
        log: L,
    ) -> Self
    where
        P: Fn(String, GatewaySleepRoute) -> PF + Send + Sync + 'static,
        PF: Future<Output = Result<SleepPrepareOutcome, String>> + Send + 'static,
        R: Fn(String, GatewaySleepRoute) -> RF + Send + Sync + 'static,
        RF: Future<Output = Result<(), String>> + Send + 'static,
        F: Fn() -> FF + Send + Sync + 'static,
        FF: Future<Output = ()> + Send + 'static,
        C: Fn() -> Option<GatewaySleepRoute> + Send + Sync + 'static,
        D: Fn(Duration) -> DF + Send + Sync + 'static,
        DF: Future<Output = ()> + Send + 'static,
        L: Fn(String) + Send + Sync + 'static,
    {
        Self {
            request_id,
            current_route: Arc::new(current_route),
            prepare: Arc::new(move |request_id, route| Box::pin(prepare(request_id, route))),
            resume: Arc::new(move |suspension_id, route| Box::pin(resume(suspension_id, route))),
            refresh: Arc::new(move || Box::pin(refresh())),
            retry_delay: Arc::new(move |delay| Box::pin(retry_delay(delay))),
            log: Arc::new(log),
            suspension: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) async fn will_sleep(&self) {
        // The listener awaits preparation before it can consume the wake signal.
        let Some(route) = (self.current_route)() else {
            return;
        };
        match (self.prepare)(self.request_id.clone(), route.clone()).await {
            Ok(SleepPrepareOutcome::Ready { suspension_id }) => {
                if (self.current_route)().as_ref() != Some(&route) {
                    self.log_route_changed();
                    return;
                }
                *self
                    .suspension
                    .lock()
                    .expect("gateway sleep state mutex poisoned") = Some(HeldSuspension {
                    id: suspension_id,
                    route,
                });
            }
            Ok(SleepPrepareOutcome::Busy) => {
                (self.log)("gateway sleep preparation skipped because the gateway is busy".into());
            }
            Err(error) => {
                (self.log)(format!("gateway sleep preparation failed: {error}"));
            }
        }
    }

    pub(crate) fn did_wake(&self) -> impl Future<Output = ()> + Send + 'static {
        // Take the lease at the signal, before the recovery task is scheduled.
        let suspension = self
            .suspension
            .lock()
            .expect("gateway sleep state mutex poisoned")
            .take();
        let controller = self.clone();
        async move {
            if (controller.current_route)().is_none() {
                if suspension.is_some() {
                    controller.log_route_changed();
                }
                return;
            }
            (controller.refresh)().await;
            if let Some(suspension) = suspension {
                controller.resume_with_retries(suspension).await;
            }
        }
    }

    fn log_route_changed(&self) {
        (self.log)(
            "dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"
                .into(),
        );
    }

    async fn resume_with_retries(&self, suspension: HeldSuspension) {
        for attempt in 1..=RESUME_ATTEMPTS {
            if (self.current_route)().as_ref() != Some(&suspension.route) {
                self.log_route_changed();
                return;
            }
            match (self.resume)(suspension.id.clone(), suspension.route.clone()).await {
                Ok(()) => return,
                Err(error) => {
                    (self.log)(format!(
                        "gateway wake resume attempt {attempt} failed: {error}"
                    ));
                    if attempt < RESUME_ATTEMPTS {
                        (self.retry_delay)(RESUME_RETRY_DELAY).await;
                    }
                }
            }
        }
        (self.log)("giving up on gateway wake resume; lease will self-expire".into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn local_route(url: &str, generation: u64) -> GatewaySleepRoute {
        GatewaySleepRoute {
            ws_url: url.to_string(),
            generation,
        }
    }

    fn route_state(value: Option<&str>) -> Arc<Mutex<Option<GatewaySleepRoute>>> {
        Arc::new(Mutex::new(value.map(|url| local_route(url, 1))))
    }

    fn current_route(
        route: &Arc<Mutex<Option<GatewaySleepRoute>>>,
    ) -> impl Fn() -> Option<GatewaySleepRoute> + Send + Sync + 'static {
        let route = Arc::clone(route);
        move || route.lock().expect("route mutex poisoned").clone()
    }

    fn no_delay(_: Duration) -> impl Future<Output = ()> + Send {
        std::future::ready(())
    }

    #[tokio::test]
    async fn ready_preparation_resumes_once_after_refresh() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let events = Arc::new(Mutex::new(Vec::new()));
        let prepare_events = Arc::clone(&events);
        let resume_events = Arc::clone(&events);
        let refresh_events = Arc::clone(&events);
        let request_ids = Arc::new(Mutex::new(Vec::new()));
        let prepared_ids = Arc::clone(&request_ids);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            move |request_id, _| {
                prepared_ids.lock().unwrap().push(request_id);
                prepare_events.lock().unwrap().push("prepare");
                async {
                    Ok(SleepPrepareOutcome::Ready {
                        suspension_id: "suspension-1".into(),
                    })
                }
            },
            move |_, _| {
                resume_events.lock().unwrap().push("resume");
                async { Ok(()) }
            },
            move || {
                refresh_events.lock().unwrap().push("refresh");
                async {}
            },
            no_delay,
            |_| {},
        );

        controller.will_sleep().await;
        controller.did_wake().await;
        controller.did_wake().await;

        assert_eq!(*request_ids.lock().unwrap(), ["linux-sleep-test-run"]);
        assert_eq!(
            *events.lock().unwrap(),
            ["prepare", "refresh", "resume", "refresh"]
        );
    }

    #[tokio::test]
    async fn busy_preparation_does_not_resume() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async { Ok(SleepPrepareOutcome::Busy) },
            move |_, _| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["gateway sleep preparation skipped because the gateway is busy"]
        );
    }

    #[tokio::test]
    async fn failed_preparation_does_not_resume() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async { Err("prepare failed".into()) },
            move |_, _| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["gateway sleep preparation failed: prepare failed"]
        );
    }

    #[tokio::test]
    async fn changed_route_drops_the_suspension() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-1".into(),
                })
            },
            move |_, _| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        *route.lock().unwrap() = Some(local_route("ws://127.0.0.1:19001", 2));
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(
            *logs.lock().unwrap(),
            ["dropping gateway sleep lease: route/mode changed across sleep; lease will self-expire"]
        );
    }

    #[tokio::test]
    async fn missing_or_remote_route_drops_a_held_suspension() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let resumes = Arc::new(AtomicUsize::new(0));
        let resumed = Arc::clone(&resumes);
        let refreshes = Arc::new(AtomicUsize::new(0));
        let refreshed = Arc::clone(&refreshes);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-1".into(),
                })
            },
            move |_, _| {
                resumed.fetch_add(1, Ordering::SeqCst);
                async { Ok(()) }
            },
            move || {
                refreshed.fetch_add(1, Ordering::SeqCst);
                async {}
            },
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        *route.lock().unwrap() = None;
        controller.did_wake().await;
        *route.lock().unwrap() = Some(local_route("ws://127.0.0.1:18789", 3));
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(logs.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn resume_retries_only_on_its_original_route() {
        for (replacement, unchanged) in [
            (Some(local_route("ws://127.0.0.1:18789", 1)), true),
            (Some(local_route("ws://127.0.0.1:19001", 2)), false),
            (None, false),
            (Some(local_route("ws://127.0.0.1:18789", 3)), false),
        ] {
            let route = route_state(Some("ws://127.0.0.1:18789"));
            let delay_route = route.clone();
            let attempts = Arc::new(AtomicUsize::new(0));
            let attempted = Arc::clone(&attempts);
            let delays = Arc::new(AtomicUsize::new(0));
            let delayed = Arc::clone(&delays);
            let controller = GatewaySleepCycleController::new(
                "linux-sleep-test-run".into(),
                current_route(&route),
                |_, _| async {
                    Ok(SleepPrepareOutcome::Ready {
                        suspension_id: "suspension-retry".into(),
                    })
                },
                move |_, _| {
                    let attempt = attempted.fetch_add(1, Ordering::SeqCst);
                    async move {
                        if attempt == 0 {
                            Err("transport failed".into())
                        } else {
                            Ok(())
                        }
                    }
                },
                || async {},
                move |_| {
                    delayed.fetch_add(1, Ordering::SeqCst);
                    *delay_route.lock().unwrap() = replacement.clone();
                    async {}
                },
                |_| {},
            );

            controller.will_sleep().await;
            controller.did_wake().await;

            assert_eq!(
                attempts.load(Ordering::SeqCst),
                if unchanged { 2 } else { 1 }
            );
            assert_eq!(delays.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn resume_exhausts_three_attempts() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let logs = Arc::new(Mutex::new(Vec::new()));
        let recorded_logs = Arc::clone(&logs);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-exhaust".into(),
                })
            },
            move |_, _| {
                attempted.fetch_add(1, Ordering::SeqCst);
                async { Err("transport failed".into()) }
            },
            || async {},
            no_delay,
            move |message| recorded_logs.lock().unwrap().push(message),
        );

        controller.will_sleep().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert!(logs
            .lock()
            .unwrap()
            .iter()
            .any(|log| log.contains("giving up")));
    }

    #[tokio::test]
    async fn wake_always_clears_the_held_lease() {
        let route = route_state(Some("ws://127.0.0.1:18789"));
        let attempts = Arc::new(AtomicUsize::new(0));
        let attempted = Arc::clone(&attempts);
        let controller = GatewaySleepCycleController::new(
            "linux-sleep-test-run".into(),
            current_route(&route),
            |_, _| async {
                Ok(SleepPrepareOutcome::Ready {
                    suspension_id: "suspension-failure".into(),
                })
            },
            move |_, _| {
                attempted.fetch_add(1, Ordering::SeqCst);
                async { Err("transport failed".into()) }
            },
            || async {},
            no_delay,
            |_| {},
        );

        controller.will_sleep().await;
        controller.did_wake().await;
        controller.did_wake().await;

        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }
}

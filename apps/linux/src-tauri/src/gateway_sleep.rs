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

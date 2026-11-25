use crate::gateway_sleep::{GatewaySleepCycleController, GatewaySleepRoute, SleepPrepareOutcome};
use std::{
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

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
async fn unsuccessful_preparation_refreshes_without_resuming() {
    for (outcome, expected_log) in [
        (
            Ok(SleepPrepareOutcome::Busy),
            "gateway sleep preparation skipped because the gateway is busy",
        ),
        (
            Err("prepare failed".to_string()),
            "gateway sleep preparation failed: prepare failed",
        ),
    ] {
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
            move |_, _| {
                let outcome = outcome.clone();
                async move { outcome }
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
        controller.did_wake().await;

        assert_eq!(resumes.load(Ordering::SeqCst), 0);
        assert_eq!(refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(*logs.lock().unwrap(), [expected_log]);
    }
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
async fn resume_exhausts_three_attempts_and_clears_the_lease() {
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

    controller.did_wake().await;
    assert_eq!(attempts.load(Ordering::SeqCst), 3);
}

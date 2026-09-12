use crate::gateway::{GatewayAction, GatewaySnapshot};
use crate::installer::InstallChannel;
use crate::remote_gateway::RemoteGatewayRequest;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use tokio::sync::oneshot;

pub(crate) enum GatewayOperation {
    Connect,
    ConnectExplicitLocal,
    ConnectRemote(RemoteGatewayRequest),
    RetryRemote,
    Install(InstallChannel),
    Action(GatewayAction),
    RecoverRemote { child_id: u64 },
}

struct QueuedGatewayOperation {
    operation: GatewayOperation,
    reply: Option<oneshot::Sender<Result<GatewaySnapshot, String>>>,
    selection: u64,
}

pub(crate) struct GatewayOperationQueue {
    sender: mpsc::Sender<QueuedGatewayOperation>,
    selection: Arc<Mutex<u64>>,
}

impl GatewayOperationQueue {
    pub(crate) fn new<F, E>(sink: F, show_error: E) -> Self
    where
        F: Fn(GatewayOperation, u64) -> Result<GatewaySnapshot, String> + Send + Sync + 'static,
        E: Fn(&str) + Send + Sync + 'static,
    {
        let (sender, receiver) = mpsc::channel::<QueuedGatewayOperation>();
        let selection = Arc::new(Mutex::new(0));
        let current = Arc::clone(&selection);
        thread::Builder::new()
            .name("openclaw-gateway-operations".to_string())
            .spawn(move || {
                for request in receiver {
                    if matches!(request.operation, GatewayOperation::RecoverRemote { .. })
                        && *current.lock().expect("selection") != request.selection
                    {
                        continue;
                    }
                    let result = sink(request.operation, request.selection);
                    if let Some(reply) = request.reply {
                        let _ = reply.send(result);
                    } else if let Err(error) = result {
                        show_error(&error);
                    }
                }
            })
            .expect("gateway operation worker should start");
        Self { sender, selection }
    }

    pub(crate) fn selection_is_current(&self, expected: u64) -> bool {
        *self.selection.lock().expect("selection") == expected
    }

    pub(crate) fn while_current<T>(&self, expected: u64, publish: impl FnOnce() -> T) -> Option<T> {
        let selection = self.selection.lock().expect("selection");
        (*selection == expected).then(publish)
    }

    pub(crate) fn invalidate_recovery(&self) {
        let mut selection = self.selection.lock().expect("selection");
        *selection = selection.wrapping_add(1);
    }

    pub(crate) fn submit_recovery(&self, selection: u64, child_id: u64) {
        let _ = self.sender.send(QueuedGatewayOperation {
            operation: GatewayOperation::RecoverRemote { child_id },
            reply: None,
            selection,
        });
    }

    pub(crate) fn submit_connect(&self) {
        self.submit_detached(GatewayOperation::Connect);
    }

    pub(crate) fn submit_action(&self, action: GatewayAction) {
        self.submit_detached(GatewayOperation::Action(action));
    }

    pub(crate) async fn execute(
        &self,
        operation: GatewayOperation,
    ) -> Result<GatewaySnapshot, String> {
        let (reply, receiver) = oneshot::channel();
        self.submit(operation, Some(reply))?;
        receiver
            .await
            .map_err(|_| "Gateway operation worker stopped unexpectedly.".to_string())?
    }

    fn submit_detached(&self, operation: GatewayOperation) {
        let _ = self.submit(operation, None);
    }

    fn submit(
        &self,
        operation: GatewayOperation,
        reply: Option<oneshot::Sender<Result<GatewaySnapshot, String>>>,
    ) -> Result<(), String> {
        // Invalidate automatic work at submission, while retaining every
        // explicit operation in channel order.
        let mut selection = self.selection.lock().expect("selection");
        *selection = selection.wrapping_add(1);
        self.sender
            .send(QueuedGatewayOperation {
                operation,
                reply,
                selection: *selection,
            })
            .map_err(|_| "Gateway operation queue is unavailable.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{GatewayOperation, GatewayOperationQueue};
    use crate::gateway::GatewayAction;
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    #[derive(Debug, Eq, PartialEq)]
    enum ObservedOperation {
        Stop,
        Connect,
    }

    #[test]
    fn executes_every_rapid_submission_in_order() {
        let (sender, receiver) = mpsc::channel();
        let queue = GatewayOperationQueue::new(
            move |operation, _| {
                let observed = match operation {
                    GatewayOperation::Connect => 0,
                    GatewayOperation::Action(GatewayAction::Stop) => 1,
                    _ => panic!("unexpected operation"),
                };
                sender.send(observed).expect("record operation");
                Err("test operation".to_string())
            },
            |_| {},
        );
        let expected = (0..256).map(|index| index % 2).collect::<Vec<_>>();
        for operation in &expected {
            if *operation == 0 {
                queue.submit_connect();
            } else {
                queue.submit_action(GatewayAction::Stop);
            }
        }
        let observed = (0..expected.len())
            .map(|_| {
                receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(observed, expected);
    }

    #[test]
    fn orders_non_tray_connect_after_gateway_action() {
        let contention = Arc::new(Barrier::new(2));
        let worker_contention = Arc::clone(&contention);
        let (observed_sender, observed_receiver) = mpsc::channel();
        let queue = Arc::new(GatewayOperationQueue::new(
            move |operation, _| {
                let observed = match operation {
                    GatewayOperation::Action(GatewayAction::Stop) => {
                        worker_contention.wait();
                        thread::sleep(Duration::from_millis(100));
                        ObservedOperation::Stop
                    }
                    GatewayOperation::Connect => ObservedOperation::Connect,
                    _ => panic!("unexpected operation"),
                };
                observed_sender.send(observed).expect("record operation");
                Err("test operation".to_string())
            },
            |_| {},
        ));

        let connect_queue = Arc::clone(&queue);
        let connect_submitter = thread::spawn(move || {
            contention.wait();
            connect_queue.submit_connect();
        });
        let action_queue = Arc::clone(&queue);
        let action_submitter = thread::spawn(move || {
            action_queue.submit_action(GatewayAction::Stop);
        });

        action_submitter.join().expect("action submitter");
        connect_submitter.join().expect("connect submitter");
        let observed = (0..2)
            .map(|_| {
                observed_receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("operation should execute")
            })
            .collect::<Vec<_>>();
        assert_eq!(
            observed,
            [ObservedOperation::Stop, ObservedOperation::Connect]
        );
    }

    #[test]
    fn selection_submission_invalidates_queued_recovery_without_dropping_explicit_work() {
        let entered = Arc::new(Barrier::new(2));
        let release = Arc::new(Barrier::new(2));
        let worker_entered = Arc::clone(&entered);
        let worker_release = Arc::clone(&release);
        let (sender, receiver) = mpsc::channel();
        let queue = GatewayOperationQueue::new(
            move |operation, _| {
                let observed = match operation {
                    GatewayOperation::Action(GatewayAction::Stop) => {
                        worker_entered.wait();
                        worker_release.wait();
                        ObservedOperation::Stop
                    }
                    GatewayOperation::Connect => ObservedOperation::Connect,
                    _ => panic!("obsolete recovery executed"),
                };
                sender.send(observed).unwrap();
                Err("fixture".to_string())
            },
            |_| {},
        );
        queue.submit_action(GatewayAction::Stop);
        entered.wait();
        queue.submit_recovery(1, 23);
        queue.submit_connect();
        assert!(
            !queue.selection_is_current(1),
            "invalidation must precede execution"
        );
        release.wait();
        let observed = (0..2)
            .map(|_| receiver.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            observed,
            [ObservedOperation::Stop, ObservedOperation::Connect]
        );
    }
}
